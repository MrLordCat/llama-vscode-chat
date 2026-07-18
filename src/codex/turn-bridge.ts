import * as vscode from "vscode";

import type { LlamaLogSink } from "../logger";
import type { CodexAppServerClient, CodexServerNotification } from "./app-server-client";
import type { CodexDynamicToolCallResponse } from "./dynamic-tools";
import type {
	CodexAgentMessageDeltaParams,
	CodexItemNotificationParams,
	CodexReasoningDeltaParams,
	CodexThreadTokenUsage,
	CodexTokenUsageParams,
	CodexTurnCompletedParams,
	CodexTurnStartResponse,
} from "./protocol";

export interface CodexDelegatedToolCall {
	callId: string;
	tool: string;
	input: Record<string, unknown>;
	turnId?: string;
}

export type CodexTurnBoundary =
	| { kind: "delegated"; call: CodexDelegatedToolCall }
	| { kind: "completed"; completed: CodexTurnCompletedParams };

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

interface PendingToolResponse {
	call: CodexDelegatedToolCall;
	resolve: (response: CodexDynamicToolCallResponse) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function getThreadId(params: unknown): string | undefined {
	const value = asRecord(params).threadId;
	return typeof value === "string" ? value : undefined;
}

function truncate(value: string, maxLength = 240): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

/** Keeps one app-server turn alive while Copilot executes native tool cards. */
export class CodexTurnBridge implements vscode.Disposable {
	private boundary = deferred<CodexTurnBoundary>();
	private readonly pendingTools = new Map<string, PendingToolResponse>();
	private pendingToolTimer: NodeJS.Timeout | undefined;
	private delegationScheduled = false;
	private progress: vscode.Progress<vscode.LanguageModelResponsePart> | undefined;
	private cancellation: vscode.Disposable | undefined;
	private readonly notificationDisposable: vscode.Disposable;
	private readonly stopDisposable: vscode.Disposable;
	private readonly itemPhases = new Map<string, string | null>();
	private readonly emittedItemChars = new Map<string, number>();
	private readonly finalTextChunks: string[] = [];
	private segmentTextChunks: string[] = [];
	private disposed = false;

	turnId: string | undefined;
	tokenUsage: CodexThreadTokenUsage | undefined;
	finalTextChars = 0;
	readonly startedAt = Date.now();

	constructor(
		private readonly client: CodexAppServerClient,
		readonly threadId: string,
		private readonly logSink?: LlamaLogSink,
		private readonly onToolTimeout?: (bridge: CodexTurnBridge) => void
	) {
		this.notificationDisposable = client.onNotification(notification => this.handleNotification(notification));
		this.stopDisposable = client.onDidStop(error => {
			this.boundary.reject(error);
			for (const pending of this.pendingTools.values()) {
				pending.resolve({
					contentItems: [{ type: "inputText", text: "Codex app-server stopped before the tool completed." }],
					success: false,
				});
			}
			this.pendingTools.clear();
			this.onToolTimeout?.(this);
		});
	}

	get finalText(): string {
		return this.finalTextChunks.join("");
	}

	get segmentText(): string {
		return this.segmentTextChunks.join("");
	}

	get pendingCalls(): readonly CodexDelegatedToolCall[] {
		return [...this.pendingTools.values()].map(pending => pending.call);
	}

	async start(
		params: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<CodexTurnBoundary> {
		this.attach(progress, token);
		const started = await this.client.request<CodexTurnStartResponse>("turn/start", params);
		this.turnId = started.turn.id;
		return this.waitForBoundary();
	}

	async resume(
		responses: ReadonlyMap<string, CodexDynamicToolCallResponse>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<CodexTurnBoundary> {
		if (this.pendingTools.size === 0) {
			throw new Error("Codex turn has no pending native tool call to resume");
		}
		const missing = [...this.pendingTools.keys()].filter(callId => !responses.has(callId));
		if (missing.length > 0) {
			throw new Error(`Native tool results are incomplete; missing call ids: ${missing.join(", ")}`);
		}
		this.boundary = deferred<CodexTurnBoundary>();
		this.attach(progress, token);
		if (this.pendingToolTimer) {
			clearTimeout(this.pendingToolTimer);
			this.pendingToolTimer = undefined;
		}
		for (const [callId, pending] of this.pendingTools) {
			pending.resolve(responses.get(callId)!);
		}
		this.pendingTools.clear();
		return this.waitForBoundary();
	}

	delegate(call: CodexDelegatedToolCall): Promise<CodexDynamicToolCallResponse> {
		if (this.disposed || this.pendingTools.has(call.callId) || !this.progress) {
			return Promise.resolve({
				contentItems: [{ type: "inputText", text: "Native VS Code tool delegation is unavailable." }],
				success: false,
			});
		}
		const response = new Promise<CodexDynamicToolCallResponse>(resolve => {
			this.pendingTools.set(call.callId, { call, resolve });
		});
		if (!this.pendingToolTimer) {
			this.pendingToolTimer = setTimeout(() => {
				for (const pending of this.pendingTools.values()) {
					pending.resolve({
						contentItems: [{ type: "inputText", text: "Native VS Code tool execution timed out." }],
						success: false,
					});
				}
				this.pendingTools.clear();
				this.pendingToolTimer = undefined;
				this.onToolTimeout?.(this);
			}, 30 * 60_000);
		}
		this.progress.report(new vscode.LanguageModelToolCallPart(call.callId, call.tool, call.input));
		if (!this.delegationScheduled) {
			this.delegationScheduled = true;
			setImmediate(() => {
				this.delegationScheduled = false;
				const first = this.pendingTools.values().next().value as PendingToolResponse | undefined;
				if (first) {
					this.boundary.resolve({ kind: "delegated", call: first.call });
				}
			});
		}
		return response;
	}

	async interrupt(): Promise<void> {
		if (!this.turnId) {
			return;
		}
		await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 10_000);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.detach();
		this.notificationDisposable.dispose();
		this.stopDisposable.dispose();
		if (this.pendingToolTimer) {
			clearTimeout(this.pendingToolTimer);
			this.pendingToolTimer = undefined;
		}
		for (const pending of this.pendingTools.values()) {
			pending.resolve({
				contentItems: [{ type: "inputText", text: "Native VS Code tool delegation was cancelled." }],
				success: false,
			});
		}
		this.pendingTools.clear();
	}

	private attach(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): void {
		this.segmentTextChunks = [];
		this.progress = progress;
		this.cancellation?.dispose();
		this.cancellation = token.onCancellationRequested(() => {
			void this.interrupt().catch(error => {
				this.logSink?.logError("codex.chat.interrupt_failed", error, {
					threadId: this.threadId,
					turnId: this.turnId,
				});
			});
		});
	}

	private async waitForBoundary(): Promise<CodexTurnBoundary> {
		try {
			return await this.boundary.promise;
		} finally {
			this.detach();
		}
	}

	private detach(): void {
		this.progress = undefined;
		this.cancellation?.dispose();
		this.cancellation = undefined;
	}

	private handleNotification(notification: CodexServerNotification): void {
		if (getThreadId(notification.params) !== this.threadId || this.disposed) {
			return;
		}
		try {
			switch (notification.method) {
				case "turn/started": {
					const turn = asRecord(asRecord(notification.params).turn);
					if (typeof turn.id === "string") {
						this.turnId = turn.id;
					}
					break;
				}
				case "item/started":
					this.handleItemStarted((notification.params as CodexItemNotificationParams).item);
					break;
				case "item/agentMessage/delta": {
					const params = notification.params as CodexAgentMessageDeltaParams;
					if (this.itemPhases.get(params.itemId) === "commentary") {
						this.emitThinking(params.delta, params.itemId);
					} else {
						this.progress?.report(new vscode.LanguageModelTextPart(params.delta));
						this.finalTextChars += params.delta.length;
						this.finalTextChunks.push(params.delta);
						this.segmentTextChunks.push(params.delta);
					}
					this.emittedItemChars.set(params.itemId, (this.emittedItemChars.get(params.itemId) ?? 0) + params.delta.length);
					break;
				}
				case "item/reasoning/summaryTextDelta": {
					const params = notification.params as CodexReasoningDeltaParams;
					this.emitThinking(params.delta, params.itemId);
					break;
				}
				case "item/completed": {
					const item = (notification.params as CodexItemNotificationParams).item;
					if (item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string") {
						const emitted = this.emittedItemChars.get(String(item.id)) ?? 0;
						if (emitted === 0 && item.text.length > 0) {
							this.progress?.report(new vscode.LanguageModelTextPart(item.text));
							this.finalTextChars += item.text.length;
							this.finalTextChunks.push(item.text);
							this.segmentTextChunks.push(item.text);
						}
					}
					break;
				}
				case "thread/tokenUsage/updated":
					this.tokenUsage = (notification.params as CodexTokenUsageParams).tokenUsage;
					break;
				case "turn/completed":
					this.boundary.resolve({ kind: "completed", completed: notification.params as CodexTurnCompletedParams });
					break;
				case "error": {
					const message = asRecord(notification.params).message;
					this.logSink?.logError(
						"codex.chat.notification_error",
						new Error(typeof message === "string" ? message : "Codex runtime error"),
						{ threadId: this.threadId, turnId: this.turnId }
					);
					break;
				}
			}
		} catch (error) {
			this.boundary.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private handleItemStarted(item: Record<string, unknown>): void {
		const id = typeof item.id === "string" ? item.id : undefined;
		if (item.type === "agentMessage" && id) {
			this.itemPhases.set(id, typeof item.phase === "string" ? item.phase : null);
			return;
		}
		if (!id) {
			return;
		}
		let status: string | undefined;
		if (item.type === "commandExecution" && typeof item.command === "string") {
			status = `Running command: ${truncate(item.command)}\n`;
		} else if (item.type === "fileChange") {
			status = "Applying workspace changes...\n";
		} else if (item.type === "webSearch") {
			status = "Searching the web...\n";
		} else if (item.type === "mcpToolCall" && typeof item.tool === "string") {
			status = `Using ${item.tool}...\n`;
		}
		if (status) {
			this.emitThinking(status, id);
		}
	}

	private emitThinking(text: string, id?: string): void {
		if (!text || !this.progress) {
			return;
		}
		const ThinkingCtor = (vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as
			| (new (text: string, id?: string, metadata?: unknown) => unknown)
			| undefined;
		if (ThinkingCtor) {
			this.progress.report(new ThinkingCtor(text, id) as vscode.LanguageModelResponsePart);
		}
	}
}
