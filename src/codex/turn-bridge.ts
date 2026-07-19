import * as vscode from "vscode";

import type { LlamaLogSink } from "../logger";
import type { CodexAppServerClient, CodexServerNotification } from "./app-server-client";
import type { CodexDynamicToolCallResponse } from "./dynamic-tools";
import type {
	CodexAgentMessageDeltaParams,
	CodexItemNotificationParams,
	CodexReasoningDeltaParams,
	CodexThreadReadResponse,
	CodexThreadTurnSnapshot,
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

function getTurnId(params: unknown): string | undefined {
	const record = asRecord(params);
	if (typeof record.turnId === "string") {
		return record.turnId;
	}
	const nested = asRecord(record.turn).id;
	return typeof nested === "string" ? nested : undefined;
}

function truncate(value: string, maxLength = 240): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

const CODEX_TURN_RECONCILE_POLL_MS = 2_000;
// High-effort Codex models can legitimately spend well over a minute between
// streamed items after a tool result. Keep polling, but retain a finite guard.
const CODEX_TURN_RECONCILE_MAX_IDLE_MS = 3 * 60_000;

export class CodexStaleTurnError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexStaleTurnError";
	}
}

export class CodexInternalToolBlockedError extends Error {
	constructor(readonly itemType: string) {
		super(`Blocked internal Codex ${itemType}; all actions must use native VS Code tools`);
		this.name = "CodexInternalToolBlockedError";
	}
}

const CODEX_INTERNAL_ACTION_ITEMS = new Set([
	"commandExecution",
	"fileChange",
	"webSearch",
	"mcpToolCall",
	"imageGeneration",
]);

export function isCodexInternalActionItem(item: Record<string, unknown>): boolean {
	return typeof item.type === "string" && CODEX_INTERNAL_ACTION_ITEMS.has(item.type);
}

/** Keeps one app-server turn alive while Copilot executes native tool cards. */
export class CodexTurnBridge implements vscode.Disposable {
	private boundary = deferred<CodexTurnBoundary>();
	private readonly pendingTools = new Map<string, PendingToolResponse>();
	private readonly reportedToolCallIds = new Set<string>();
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
	private segmentEstimatedOutputChars = 0;
	private boundaryPending = true;
	private reconcileTimer: NodeJS.Timeout | undefined;
	private reconcileInFlight = false;
	private reconciliationActive = false;
	private reconcileDeadlineAt = 0;
	private reconcilePollCount = 0;
	private lastReconcileStatus: string | undefined;
	private ephemeralTerminalObservations = 0;
	private completedTurn: CodexTurnCompletedParams | undefined;
	private disposed = false;

	turnId: string | undefined;
	tokenUsage: CodexThreadTokenUsage | undefined;
	finalTextChars = 0;
	readonly startedAt = Date.now();

	constructor(
		private readonly client: CodexAppServerClient,
		readonly threadId: string,
		private readonly logSink?: LlamaLogSink,
		private readonly onToolTimeout?: (bridge: CodexTurnBridge) => void,
		private readonly onTokenUsage?: (bridge: CodexTurnBridge, usage: CodexThreadTokenUsage) => void,
		private readonly onOutputProgress?: (bridge: CodexTurnBridge, estimatedOutputTokens: number) => void,
		public ephemeral = false,
		private readonly vsCodeToolsOnly = false
	) {
		this.notificationDisposable = client.onNotification(notification => this.handleNotification(notification));
		this.stopDisposable = client.onDidStop(error => {
			this.rejectBoundary(error);
			for (const pending of this.pendingTools.values()) {
				pending.resolve({
					contentItems: [{ type: "inputText", text: "Codex app-server stopped before the tool completed." }],
					success: false,
				});
			}
			this.pendingTools.clear();
			this.reportedToolCallIds.clear();
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

	get reportedCalls(): readonly CodexDelegatedToolCall[] {
		return [...this.pendingTools.values()]
			.filter(pending => this.reportedToolCallIds.has(pending.call.callId))
			.map(pending => pending.call);
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

	/** Starts one follow-up turn on the same thread after a transient terminal failure. */
	async restart(
		params: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<CodexTurnBoundary> {
		if (this.disposed) {
			throw new Error("Codex turn bridge is disposed");
		}
		if (this.pendingTools.size > 0) {
			throw new Error("Codex turn still has pending native tool calls");
		}
		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = undefined;
		}
		this.boundary = deferred<CodexTurnBoundary>();
		this.boundaryPending = true;
		this.reconciliationActive = false;
		this.reconcileDeadlineAt = 0;
		this.reconcilePollCount = 0;
		this.lastReconcileStatus = undefined;
		this.ephemeralTerminalObservations = 0;
		this.completedTurn = undefined;
		this.turnId = undefined;
		this.attach(progress, token);
		try {
			const started = await this.client.request<CodexTurnStartResponse>("turn/start", params);
			this.turnId = started.turn.id;
			return await this.waitForBoundary();
		} catch (error) {
			this.detach();
			this.boundaryPending = false;
			throw error;
		}
	}

	async resume(
		responses: ReadonlyMap<string, CodexDynamicToolCallResponse>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<CodexTurnBoundary> {
		if (this.pendingTools.size === 0) {
			throw new Error("Codex turn has no pending native tool call to resume");
		}
		const missing = [...this.reportedToolCallIds].filter(callId => !responses.has(callId));
		if (missing.length > 0) {
			throw new Error(`Native tool results are incomplete; missing call ids: ${missing.join(", ")}`);
		}
		this.boundary = deferred<CodexTurnBoundary>();
		this.boundaryPending = true;
		this.reconciliationActive = true;
		this.reconcileDeadlineAt = Date.now() + CODEX_TURN_RECONCILE_MAX_IDLE_MS;
		this.reconcilePollCount = 0;
		this.lastReconcileStatus = undefined;
		this.attach(progress, token);
		for (const callId of [...this.reportedToolCallIds]) {
			const pending = this.pendingTools.get(callId);
			const response = responses.get(callId);
			if (pending && response) {
				pending.resolve(response);
				this.pendingTools.delete(callId);
			}
			this.reportedToolCallIds.delete(callId);
		}
		if (this.pendingTools.size > 0) {
			this.reportPendingToolCalls();
			this.scheduleDelegationBoundary();
			return this.waitForBoundary();
		}
		if (this.pendingToolTimer) {
			clearTimeout(this.pendingToolTimer);
			this.pendingToolTimer = undefined;
		}
		const completedTurn = this.completedTurn;
		if (completedTurn && completedTurn.turn.id === this.turnId) {
			this.resolveBoundary({ kind: "completed", completed: completedTurn });
		} else {
			this.scheduleReconciliation(0);
		}
		return this.waitForBoundary();
	}

	delegate(call: CodexDelegatedToolCall): Promise<CodexDynamicToolCallResponse> {
		if (this.disposed) {
			return Promise.resolve(this.createUnavailableToolResponse(call, "bridge-disposed"));
		}
		if (this.pendingTools.has(call.callId)) {
			return Promise.resolve(this.createUnavailableToolResponse(call, "duplicate-call-id"));
		}
		if (!this.progress && this.pendingTools.size === 0) {
			return Promise.resolve(this.createUnavailableToolResponse(call, "detached-without-pending-turn"));
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
				this.reportedToolCallIds.clear();
				this.pendingToolTimer = undefined;
				this.onToolTimeout?.(this);
			}, 30 * 60_000);
		}
		if (!this.progress) {
			this.logSink?.log("codex.chat.tool_delegation_queued", {
				threadId: this.threadId,
				turnId: this.turnId,
				callId: call.callId,
				tool: call.tool,
				pendingToolCount: this.pendingTools.size,
				reportedToolCount: this.reportedToolCallIds.size,
			}, "debug");
			return response;
		}
		this.reportPendingToolCalls();
		this.scheduleDelegationBoundary();
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
		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = undefined;
		}
		for (const pending of this.pendingTools.values()) {
			pending.resolve({
				contentItems: [{ type: "inputText", text: "Native VS Code tool delegation was cancelled." }],
				success: false,
			});
		}
		this.pendingTools.clear();
		this.reportedToolCallIds.clear();
	}

	private reportPendingToolCalls(): void {
		const progress = this.progress;
		if (!progress) {
			return;
		}
		for (const pending of this.pendingTools.values()) {
			if (this.reportedToolCallIds.has(pending.call.callId)) {
				continue;
			}
			progress.report(new vscode.LanguageModelToolCallPart(
				pending.call.callId,
				pending.call.tool,
				pending.call.input
			));
			this.reportedToolCallIds.add(pending.call.callId);
		}
	}

	private scheduleDelegationBoundary(): void {
		if (this.delegationScheduled) {
			return;
		}
		this.delegationScheduled = true;
		setImmediate(() => {
			this.delegationScheduled = false;
			const first = this.reportedCalls[0];
			if (first) {
				this.resolveBoundary({ kind: "delegated", call: first });
			}
		});
	}

	private createUnavailableToolResponse(
		call: CodexDelegatedToolCall,
		reason: "bridge-disposed" | "duplicate-call-id" | "detached-without-pending-turn"
	): CodexDynamicToolCallResponse {
		this.logSink?.log("codex.chat.tool_delegation_unavailable", {
			threadId: this.threadId,
			turnId: this.turnId,
			callId: call.callId,
			tool: call.tool,
			reason,
			pendingToolCount: this.pendingTools.size,
			reportedToolCount: this.reportedToolCallIds.size,
			boundaryPending: this.boundaryPending,
		}, "warn");
		return {
			contentItems: [{
				type: "inputText",
				text: `Native VS Code tool delegation is unavailable (${reason}).`,
			}],
			success: false,
		};
	}

	private attach(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): void {
		this.segmentTextChunks = [];
		this.segmentEstimatedOutputChars = 0;
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
		const notificationTurnId = getTurnId(notification.params);
		if (this.turnId && notificationTurnId && notificationTurnId !== this.turnId) {
			return;
		}
		if (!this.turnId && notificationTurnId) {
			this.turnId = notificationTurnId;
		}
		const activeTurnNotification = !this.turnId || !notificationTurnId || notificationTurnId === this.turnId;
		if (this.reconciliationActive && this.boundaryPending && activeTurnNotification) {
			this.reconcileDeadlineAt = Date.now() + CODEX_TURN_RECONCILE_MAX_IDLE_MS;
			if (this.reconcileTimer) {
				clearTimeout(this.reconcileTimer);
				this.reconcileTimer = undefined;
			}
			this.scheduleReconciliation(CODEX_TURN_RECONCILE_POLL_MS);
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
					this.recordOutputProgress(params.delta);
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
					this.recordOutputProgress(params.delta);
					this.emitThinking(params.delta, params.itemId);
					break;
				}
				case "item/completed": {
					const item = (notification.params as CodexItemNotificationParams).item;
					if (item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string") {
						const emitted = this.emittedItemChars.get(String(item.id)) ?? 0;
						if (emitted === 0 && item.text.length > 0) {
							this.recordOutputProgress(item.text);
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
					this.onTokenUsage?.(this, this.tokenUsage);
					break;
				case "turn/completed":
					this.completedTurn = notification.params as CodexTurnCompletedParams;
					this.logSink?.log("codex.chat.turn_terminal", {
						threadId: this.threadId,
						turnId: this.completedTurn.turn.id,
						status: this.completedTurn.turn.status,
						errorMessage: this.completedTurn.turn.error?.message
							? truncate(this.completedTurn.turn.error.message, 800)
							: undefined,
					}, this.completedTurn.turn.status === "failed" ? "warn" : "debug");
					this.resolveBoundary({ kind: "completed", completed: this.completedTurn });
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
			this.rejectBoundary(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private resolveBoundary(boundary: CodexTurnBoundary): void {
		if (!this.boundaryPending) {
			return;
		}
		this.boundaryPending = false;
		this.reconciliationActive = false;
		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = undefined;
		}
		this.boundary.resolve(boundary);
	}

	private rejectBoundary(error: Error): void {
		if (!this.boundaryPending) {
			return;
		}
		this.logSink?.logError("codex.chat.turn_boundary_failed", error, {
			threadId: this.threadId,
			turnId: this.turnId,
			ephemeral: this.ephemeral,
			reconcilePollCount: this.reconcilePollCount,
			lastReconcileStatus: this.lastReconcileStatus,
		});
		this.boundaryPending = false;
		this.reconciliationActive = false;
		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = undefined;
		}
		this.boundary.reject(error);
	}

	private scheduleReconciliation(delayMs: number): void {
		if (
			this.disposed
			|| !this.reconciliationActive
			|| !this.boundaryPending
			|| this.reconcileTimer
			|| this.reconcileInFlight
		) {
			return;
		}
		const remainingMs = this.reconcileDeadlineAt - Date.now();
		if (remainingMs <= 0) {
			this.rejectBoundary(new CodexStaleTurnError(
				`Codex turn ${this.turnId ?? "unknown"} did not reach a terminal state before the reconciliation deadline`
			));
			return;
		}
		this.reconcileTimer = setTimeout(() => {
			this.reconcileTimer = undefined;
			void this.reconcileTurnBoundary();
		}, Math.min(delayMs, remainingMs));
		this.reconcileTimer.unref?.();
	}

	private async reconcileTurnBoundary(): Promise<void> {
		if (
			this.disposed
			|| !this.reconciliationActive
			|| !this.boundaryPending
			|| this.reconcileInFlight
			|| !this.turnId
		) {
			return;
		}
		this.reconcileInFlight = true;
		try {
			const remainingMs = this.reconcileDeadlineAt - Date.now();
			if (remainingMs <= 0) {
				throw new CodexStaleTurnError(
					`Codex turn ${this.turnId} did not reach a terminal state before the reconciliation deadline`
				);
			}
			const response = await this.client.request<CodexThreadReadResponse>(
				"thread/read",
				this.ephemeral ? { threadId: this.threadId } : { threadId: this.threadId, includeTurns: true },
				Math.max(1, Math.min(10_000, remainingMs))
			);
			if (!this.boundaryPending) {
				return;
			}
			this.reconcilePollCount += 1;
			if (this.ephemeral || response.thread.ephemeral) {
				this.ephemeral = true;
				const status = response.thread.status?.type;
				this.lastReconcileStatus = status ?? "unknown";
				if (!status || status === "active" || status === "inProgress" || status === "running") {
					this.ephemeralTerminalObservations = 0;
					return;
				}
				this.ephemeralTerminalObservations += 1;
				if (this.ephemeralTerminalObservations < 2) {
					return;
				}
				const completed: CodexTurnCompletedParams = {
					threadId: this.threadId,
					turn: {
						id: this.turnId,
						status: status === "failed" || status === "error" ? "failed" : "completed",
						error: status === "failed" || status === "error"
							? { message: `Ephemeral Codex thread ended with status ${status}` }
							: null,
					},
				};
				this.completedTurn = completed;
				this.resolveBoundary({ kind: "completed", completed });
				return;
			}
			const turn = response.thread.turns?.find(candidate => candidate.id === this.turnId);
			this.lastReconcileStatus = turn?.status ?? "turn-not-found";
			if (!turn || turn.status === "inProgress") {
				if (Date.now() >= this.reconcileDeadlineAt) {
					throw new CodexStaleTurnError(
						`Codex turn ${this.turnId} stopped producing events and could not be reconciled`
					);
				}
				return;
			}
			this.recoverTurnItems(turn);
			const completed: CodexTurnCompletedParams = {
				threadId: this.threadId,
				turn: {
					id: turn.id,
					status: turn.status,
					error: turn.error,
				},
			};
			this.completedTurn = completed;
			this.logSink?.log("codex.chat.turn_boundary_recovered", {
				threadId: this.threadId,
				turnId: turn.id,
				status: turn.status,
				itemCount: turn.items.length,
			}, "warn");
			this.resolveBoundary({ kind: "completed", completed });
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (!this.ephemeral && /ephemeral.*includeTurns|includeTurns.*ephemeral/i.test(normalized.message)) {
				this.ephemeral = true;
				return;
			}
			if (Date.now() >= this.reconcileDeadlineAt && !(normalized instanceof CodexStaleTurnError)) {
				this.rejectBoundary(new CodexStaleTurnError(
					`Codex turn ${this.turnId ?? "unknown"} could not be reconciled before the deadline: ${normalized.message}`
				));
				return;
			}
			if (
				normalized instanceof CodexStaleTurnError
				|| /no (?:such )?thread|thread .*not found/i.test(normalized.message)
			) {
				this.rejectBoundary(normalized instanceof CodexStaleTurnError
					? normalized
					: new CodexStaleTurnError(normalized.message));
				return;
			}
			this.logSink?.logError("codex.chat.turn_reconcile_failed", normalized, {
				threadId: this.threadId,
				turnId: this.turnId,
			});
		} finally {
			this.reconcileInFlight = false;
			if (this.boundaryPending) {
				this.scheduleReconciliation(CODEX_TURN_RECONCILE_POLL_MS);
			}
		}
	}

	private recoverTurnItems(turn: CodexThreadTurnSnapshot): void {
		for (const item of turn.items) {
			if (item.type !== "agentMessage" || item.phase === "commentary" || typeof item.text !== "string") {
				continue;
			}
			const itemId = typeof item.id === "string" ? item.id : undefined;
			const emitted = itemId ? this.emittedItemChars.get(itemId) ?? 0 : 0;
			if (emitted >= item.text.length) {
				continue;
			}
			const missing = item.text.slice(emitted);
			this.progress?.report(new vscode.LanguageModelTextPart(missing));
			this.finalTextChars += missing.length;
			this.finalTextChunks.push(missing);
			this.segmentTextChunks.push(missing);
			if (itemId) {
				this.emittedItemChars.set(itemId, item.text.length);
			}
		}
	}

	private handleItemStarted(item: Record<string, unknown>): void {
		if (this.vsCodeToolsOnly && isCodexInternalActionItem(item)) {
			const itemType = String(item.type);
			const error = new CodexInternalToolBlockedError(itemType);
			this.logSink?.log("codex.internal_tool.blocked", {
				threadId: this.threadId,
				turnId: this.turnId,
				itemType,
			}, "error");
			this.rejectBoundary(error);
			void this.interrupt().catch(interruptError => {
				this.logSink?.logError("codex.internal_tool.block_interrupt_failed", interruptError, {
					threadId: this.threadId,
					turnId: this.turnId,
					itemType,
				});
			});
			return;
		}
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

	private recordOutputProgress(text: string): void {
		if (!text) {
			return;
		}
		this.segmentEstimatedOutputChars += text.length;
		this.onOutputProgress?.(this, Math.max(1, Math.ceil(this.segmentEstimatedOutputChars / 4)));
	}
}
