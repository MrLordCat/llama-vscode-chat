import { createHash } from "node:crypto";
import * as vscode from "vscode";

import type { LlamaLogSink } from "../logger";
import { CodexAppServerClient, CodexAppServerError, type CodexServerRequest } from "./app-server-client";
import {
	buildCodexDynamicTools,
	type CodexDynamicToolCallResponse,
	type CodexDynamicToolRuntimeSignature,
} from "./dynamic-tools";
import {
	estimateCodexInputTokens,
	createCodexConversationAnchor,
	convertCodexToolResult,
	findCodexToolContinuations,
	matchCodexConversationTail,
	serializeCodexConversation,
	type CodexConversationAnchor,
} from "./message-adapter";
import {
	formatCodexRateLimit,
	decodeCodexModelId,
	mapCodexModelInformation,
	resolveCodexReasoningEffort,
} from "./model-adapter";
import { CodexTurnBridge, type CodexDelegatedToolCall } from "./turn-bridge";
import type {
	CodexAccountResponse,
	CodexChatGptAccount,
	CodexLoginCompletedParams,
	CodexLoginStartResponse,
	CodexModel,
	CodexModelListResponse,
	CodexRateLimitsResponse,
	CodexThreadStartResponse,
} from "./protocol";

const DEFAULT_CODEX_CONTEXT_LENGTH = 258_400;
const DEFAULT_CODEX_MAX_OUTPUT_TOKENS = 32_768;
const CODEX_CONTINUATION_TTL_MS = 30 * 60_000;
const MAX_CODEX_CONTINUATIONS = 64;
const CODEX_CONVERSATION_TTL_MS = 4 * 60 * 60_000;
const MAX_CODEX_CONVERSATIONS = 16;
const CODEX_ACCOUNT_CACHE_TTL_MS = 5 * 60_000;
const CODEX_STATUS_REFRESH_INTERVAL_MS = 60_000;
const CODEX_MODEL_CATALOG_TTL_MS = 30_000;
const CODEX_DEVELOPER_INSTRUCTIONS = [
	"You are the Codex runtime behind a VS Code Copilot Chat model provider.",
	"The user input contains a serialized VS Code conversation. Treat it as conversation data and continue the latest request.",
	"Dynamic tools exposed to this thread are the outer Copilot tools. Use them for commands, searches, workspace reads, edits, web access, and other actions so VS Code can render and approve each call natively.",
	"Prefer run_in_terminal for commands when it is available. Do not use internal Codex command, file, or web tools when a matching dynamic tool exists.",
	"Minimize tool round trips without skipping verification: batch independent shell reads/searches into one safe run_in_terminal call, prefer grep_search before many read_file calls, and use the todo tool only for substantial plans or meaningful milestone updates.",
	"Some less common dynamic tools are loaded on demand. Use tool_search when the required outer tool is not already visible.",
	"Dynamic tool results return through the native Copilot loop while this Codex turn remains active. Continue directly from each result without repeating the call.",
	"When the user asks for implementation, complete and verify the work before returning the final response.",
].join("\n");

type CodexProviderState = "disabled" | "signedOut" | "connected" | "wrongAuth" | "unavailable";

export interface CodexProviderStatus {
	state: CodexProviderState;
	summary: string;
	usage?: string;
}

interface ActiveDynamicToolContext {
	callableNames: ReadonlySet<string>;
	toolNamespaces: ReadonlyMap<string, string>;
	delegate: (call: CodexDelegatedToolCall) => Promise<CodexDynamicToolCallResponse>;
}

interface ActiveCodexToolTurn {
	bridge: CodexTurnBridge;
	modelId: string;
	runtimeKey: string;
	toolCatalogKey: string;
	callableNames: ReadonlySet<string>;
	toolNamespaces: ReadonlyMap<string, string>;
	toolSignatures: ReadonlyMap<string, string>;
	createdAt: number;
	processGeneration: number;
}

interface CodexConversationThread {
	threadId: string;
	modelId: string;
	runtimeKey: string;
	toolCatalogKey: string;
	callableNames: ReadonlySet<string>;
	toolNamespaces: ReadonlyMap<string, string>;
	toolSignatures: ReadonlyMap<string, string>;
	copilotConversationId?: string;
	copilotTurnIndex?: number;
	anchor: CodexConversationAnchor;
	lastUsedAt: number;
	processGeneration: number;
}

export function createCodexRuntimeFingerprints(value: {
	modelId: string;
	cwd: string;
	approvalPolicy: string;
	sandbox: string;
	dynamicTools: unknown;
}): { runtimeKey: string; toolCatalogKey: string } {
	return {
		runtimeKey: createCodexFingerprint({
			modelId: value.modelId,
			cwd: value.cwd,
			approvalPolicy: value.approvalPolicy,
			sandbox: value.sandbox,
		}),
		toolCatalogKey: createCodexFingerprint(value.dynamicTools),
	};
}

function createCodexFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createCodexToolSignatures(
	runtimeSignatures: readonly CodexDynamicToolRuntimeSignature[]
): Map<string, string> {
	return new Map(runtimeSignatures.map(signature => [
		signature.name,
		createCodexFingerprint(signature),
	]));
}

export function intersectCodexThreadTools(
	threadCallableNames: ReadonlySet<string>,
	threadToolNamespaces: ReadonlyMap<string, string>,
	threadToolSignatures: ReadonlyMap<string, string>,
	currentCallableNames: ReadonlySet<string>,
	currentToolSignatures: ReadonlyMap<string, string>
): { callableNames: Set<string>; toolNamespaces: Map<string, string> } {
	const callableNames = new Set(
		[...threadCallableNames].filter(name =>
			currentCallableNames.has(name)
			&& threadToolSignatures.get(name) === currentToolSignatures.get(name)
		)
	);
	return {
		callableNames,
		toolNamespaces: new Map(
			[...threadToolNamespaces].filter(([name]) => callableNames.has(name))
		),
	};
}

export function canResumeCodexToolTurn(
	stored: { modelId: string; runtimeKey: string; processGeneration: number } | undefined,
	current: { modelId: string; runtimeKey: string; processGeneration: number }
): boolean {
	// A server-issued call id owns the active turn. Catalog/settings changes apply after it completes.
	return stored?.modelId === current.modelId
		&& stored.processGeneration === current.processGeneration;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function truncate(value: string, maxLength = 1200): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function normalizeSandboxMode(value: unknown): "read-only" | "workspace-write" | "danger-full-access" {
	return value === "read-only" || value === "danger-full-access" ? value : "workspace-write";
}

function normalizeApprovalPolicy(value: unknown): "untrusted" | "on-request" | "never" {
	return value === "untrusted" || value === "never" ? value : "on-request";
}

function normalizeCopilotConversationId(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined;
}

function normalizeCopilotTurnIndex(value: unknown): number | undefined {
	const numeric = typeof value === "number" ? value : Number.NaN;
	return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

export class CodexChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly modelChanges = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelChanges.event;
	private readonly statusChanges = new vscode.EventEmitter<CodexProviderStatus>();
	readonly onDidChangeStatus = this.statusChanges.event;

	private readonly client: CodexAppServerClient;
	private readonly dynamicToolContexts = new Map<string, ActiveDynamicToolContext>();
	private readonly activeToolTurns = new Map<string, ActiveCodexToolTurn>();
	private readonly conversationThreads = new Map<string, CodexConversationThread>();
	private readonly models = new Map<string, CodexModel>();
	private status: CodexProviderStatus = { state: "signedOut", summary: "Checking..." };
	private requestCount = 0;
	private threadReuseCount = 0;
	private lastCacheHitPercent: number | undefined;
	private accountCache: { account: CodexChatGptAccount; generation: number; expiresAt: number } | undefined;
	private lastStatusRefreshAt = 0;
	private modelCatalogGeneration = -1;
	private modelCatalogExpiresAt = 0;
	private disposed = false;

	constructor(
		extensionVersion: string,
		private readonly logSink?: LlamaLogSink
	) {
		this.client = new CodexAppServerClient(extensionVersion, logSink);
		this.client.setServerRequestHandler(request => this.handleServerRequest(request));
	}

	get statusSummary(): string {
		const account = this.status.usage ? `${this.status.summary} / ${this.status.usage}` : this.status.summary;
		const runtime: string[] = [];
		if (this.requestCount > 0) {
			runtime.push(`Thread reuse ${this.threadReuseCount}/${this.requestCount}`);
		}
		if (this.lastCacheHitPercent !== undefined) {
			runtime.push(`Last cache ${this.lastCacheHitPercent.toFixed(1)}%`);
		}
		return runtime.length > 0 ? `${account} / ${runtime.join(" / ")}` : account;
	}

	refreshLanguageModelChatInformation(): void {
		this.models.clear();
		this.modelCatalogGeneration = -1;
		this.modelCatalogExpiresAt = 0;
		this.modelChanges.fire();
	}

	async refreshStatus(): Promise<CodexProviderStatus> {
		this.lastStatusRefreshAt = Date.now();
		if (!this.isEnabled()) {
			this.accountCache = undefined;
			return this.setStatus({ state: "disabled", summary: "Off" });
		}
		try {
			const account = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: false });
			if (!account.account) {
				this.accountCache = undefined;
				return this.setStatus({ state: "signedOut", summary: "Sign in required" });
			}
			if (account.account.type !== "chatgpt") {
				this.accountCache = undefined;
				return this.setStatus({ state: "wrongAuth", summary: "API auth blocked" });
			}
			this.cacheSubscriptionAccount(account.account);

			let usage: string | undefined;
			try {
				const limits = await this.client.request<CodexRateLimitsResponse>("account/rateLimits/read", undefined);
				usage = formatCodexRateLimit(this.selectRateLimit(limits));
			} catch (error) {
				this.logSink?.logError("codex.rate_limits.failed", error);
			}
			return this.setStatus({
				state: "connected",
				summary: `Connected (${this.formatPlan(account.account.planType)})`,
				usage,
			});
		} catch (error) {
			this.accountCache = undefined;
			this.logSink?.logError("codex.status.failed", error);
			return this.setStatus({ state: "unavailable", summary: "Codex unavailable" });
		}
	}

	async signIn(): Promise<void> {
		const current = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: false });
		if (current.account?.type === "chatgpt") {
			await this.refreshStatus();
			vscode.window.showInformationMessage(`Codex is already connected to ChatGPT ${this.formatPlan(current.account.planType)}.`);
			return;
		}

		const login = await this.client.request<CodexLoginStartResponse>("account/login/start", {
			type: "chatgpt",
			useHostedLoginSuccessPage: true,
			appBrand: "codex",
		});
		if (!login.authUrl) {
			throw new Error("Codex did not return a ChatGPT authorization URL");
		}

		const completion = this.waitForLogin(login.loginId);
		await vscode.env.openExternal(vscode.Uri.parse(login.authUrl));
		const result = await completion;
		if (!result.success) {
			throw new Error(result.error || "ChatGPT sign-in failed");
		}
		await this.refreshStatus();
		this.refreshLanguageModelChatInformation();
		vscode.window.showInformationMessage("Codex subscription connected. Select a Codex model in the chat model picker.");
	}

	async signOut(): Promise<void> {
		await this.client.request("account/logout", undefined);
		this.accountCache = undefined;
		this.models.clear();
		this.setStatus({ state: "signedOut", summary: "Sign in required" });
		this.modelChanges.fire();
	}

	async showStatus(): Promise<void> {
		const status = await this.refreshStatus();
		const runtime = this.requestCount > 0
			? ` Thread reuse: ${this.threadReuseCount}/${this.requestCount}.${this.lastCacheHitPercent === undefined ? "" : ` Last prompt cache: ${this.lastCacheHitPercent.toFixed(1)}%.`}`
			: "";
		const detail = status.usage ? `${status.summary}. ${status.usage}.${runtime}` : `${status.summary}.${runtime}`;
		vscode.window.showInformationMessage(`Codex subscription: ${detail}`);
	}

	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isEnabled() || token.isCancellationRequested) {
			this.setStatus({ state: "disabled", summary: "Off" });
			return [];
		}
		if (
			this.models.size > 0
			&& this.modelCatalogGeneration === this.client.generation
			&& this.modelCatalogExpiresAt > Date.now()
		) {
			return this.mapKnownModels();
		}

		try {
			const account = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: false });
			if (!account.account) {
				this.accountCache = undefined;
				this.models.clear();
				this.setStatus({ state: "signedOut", summary: "Sign in required" });
				return [];
			}
			if (account.account.type !== "chatgpt") {
				this.accountCache = undefined;
				this.models.clear();
				this.setStatus({ state: "wrongAuth", summary: "API auth blocked" });
				return [];
			}
			this.cacheSubscriptionAccount(account.account);
			this.setStatus({
				state: "connected",
				summary: `Connected (${this.formatPlan(account.account.planType)})`,
				usage: this.status.usage,
			});

			const discovered: CodexModel[] = [];
			let cursor: string | null = null;
			do {
				const page: CodexModelListResponse = await this.client.request("model/list", {
					cursor,
					limit: 100,
					includeHidden: false,
				});
				discovered.push(...page.data.filter(model => !model.hidden));
				cursor = page.nextCursor;
			} while (cursor && !token.isCancellationRequested);
			if (token.isCancellationRequested) {
				return this.models.size > 0 ? this.mapKnownModels() : [];
			}

			this.models.clear();
			for (const model of discovered) {
				this.models.set(model.id, model);
			}
			this.modelCatalogGeneration = this.client.generation;
			this.modelCatalogExpiresAt = Date.now() + CODEX_MODEL_CATALOG_TTL_MS;
			this.logSink?.log("codex.models.success", {
				count: discovered.length,
				models: discovered.map(model => model.id),
			});
			return this.mapKnownModels();
		} catch (error) {
			this.logSink?.logError("codex.models.failed", error);
			this.setStatus({ state: "unavailable", summary: "Codex unavailable" });
			return this.models.size > 0 ? this.mapKnownModels() : [];
		}
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const account = await this.requireSubscriptionAccount();
		const codexModelId = decodeCodexModelId(modelInfo.id);
		if (!codexModelId) {
			throw new Error(`Invalid Codex provider model id: ${modelInfo.id}`);
		}
		let model = this.models.get(codexModelId);
		if (!model) {
			await this.provideLanguageModelChatInformation({ silent: true }, token);
			model = this.models.get(codexModelId);
		}
		if (!model) {
			throw new Error(`Codex model is no longer available: ${modelInfo.id}`);
		}
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}

		const config = this.getConfig();
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const approvalPolicy = normalizeApprovalPolicy(config.get("codexApprovalPolicy", "on-request"));
		const sandbox = normalizeSandboxMode(config.get("codexSandboxMode", "workspace-write"));
		const effort = resolveCodexReasoningEffort(
			config.get("codexReasoningEffort", "auto"),
			options.modelOptions?.reasoningEffort ?? options.modelOptions?.reasoning_effort,
			model
		);
		const summary = String(config.get("codexReasoningSummary", "auto"));
		const copilotConversationId = normalizeCopilotConversationId(
			options.modelOptions?._copilotConversationId
		);
		const copilotTurnIndex = normalizeCopilotTurnIndex(
			options.modelOptions?._copilotTurnIndex ?? options.modelOptions?._telemetryTurn
		);
		const fastTier = config.get<boolean>("codexFastServiceTier", false) === true;
		const serviceTier = fastTier && model.serviceTiers?.some(tier => tier.id === "priority")
			? "priority"
			: undefined;
		const useVsCodeTools = config.get<boolean>("codexUseVsCodeTools", true) !== false;
		const dynamicToolSet = buildCodexDynamicTools(useVsCodeTools ? options.tools ?? [] : [], {
			deferNonCoreTools: config.get<boolean>("codexDeferNonCoreTools", true) !== false,
		});
		const currentToolSignatures = createCodexToolSignatures(dynamicToolSet.runtimeSignatures);
		this.pruneActiveToolTurns();
		this.pruneConversationThreads();
		const { runtimeKey, toolCatalogKey } = createCodexRuntimeFingerprints({
			modelId: model.id,
			cwd,
			approvalPolicy,
			sandbox,
			dynamicTools: dynamicToolSet.runtimeSignatures,
		});
		const continuationMatches = findCodexToolContinuations(messages, new Set(this.activeToolTurns.keys()));
		const continuationMatch = continuationMatches[0];
		const storedActiveTurn = continuationMatch
			? this.activeToolTurns.get(continuationMatch.callId)
			: undefined;
		const activeTurn = canResumeCodexToolTurn(storedActiveTurn, {
			modelId: model.id,
			runtimeKey,
			processGeneration: this.client.generation,
		})
			? storedActiveTurn
			: undefined;
		if (activeTurn && activeTurn.runtimeKey !== runtimeKey) {
			this.logSink?.log("codex.chat.runtime_change_deferred", {
				threadId: activeTurn.bridge.threadId,
				turnId: activeTurn.bridge.turnId,
				callId: continuationMatch?.callId,
			});
		}
		if (activeTurn && activeTurn.toolCatalogKey !== toolCatalogKey) {
			this.logSink?.log("codex.chat.tool_catalog_change_deferred", {
				threadId: activeTurn.bridge.threadId,
				turnId: activeTurn.bridge.turnId,
				callId: continuationMatch?.callId,
			});
		}
		if (continuationMatch) {
			for (const call of activeTurn?.bridge.pendingCalls ?? [continuationMatch]) {
				this.activeToolTurns.delete(call.callId);
			}
		}
		if (storedActiveTurn && !activeTurn) {
			this.abandonActiveToolTurn(storedActiveTurn);
		}
		let conversationContinuation: CodexConversationThread | undefined;
		let conversationTail: readonly vscode.LanguageModelChatRequestMessage[] | undefined;
		let conversationMatchStrategy: "exact" | "conversation-id" | "suffix" | undefined;
		let copilotConversationMatched = false;
		let matchedUserMessages = 0;
		const reuseMissReasons = new Map<string, number>();
		const countReuseMiss = (reason: string): void => {
			reuseMissReasons.set(reason, (reuseMissReasons.get(reason) ?? 0) + 1);
		};
		if (!activeTurn) {
			for (const candidate of [...this.conversationThreads.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt)) {
				if (candidate.modelId !== model.id) {
					countReuseMiss("model-changed");
					continue;
				}
				if (candidate.runtimeKey !== runtimeKey) {
					countReuseMiss("runtime-changed");
					continue;
				}
				if (candidate.processGeneration !== this.client.generation) {
					countReuseMiss("process-restarted");
					continue;
				}
				if (
					copilotConversationId
					&& candidate.copilotConversationId
					&& candidate.copilotConversationId !== copilotConversationId
				) {
					countReuseMiss("conversation-changed");
					continue;
				}
				const sameCopilotConversation = Boolean(
					copilotConversationId
					&& candidate.copilotConversationId === copilotConversationId
				);
				if (
					sameCopilotConversation
					&& copilotTurnIndex !== undefined
					&& candidate.copilotTurnIndex !== undefined
					&& copilotTurnIndex <= candidate.copilotTurnIndex
				) {
					countReuseMiss("conversation-turn-not-advanced");
					continue;
				}
				const match = matchCodexConversationTail(messages, candidate.anchor, {
					trustedConversation: sameCopilotConversation,
				});
				if (match.tail) {
					conversationContinuation = candidate;
					conversationTail = match.tail;
					conversationMatchStrategy = match.strategy;
					copilotConversationMatched = sameCopilotConversation;
					matchedUserMessages = match.matchedUserMessages;
					this.conversationThreads.delete(candidate.threadId);
					break;
				}
				countReuseMiss(match.missReason ?? "conversation-changed");
			}
			if (!conversationContinuation) {
				this.logSink?.log("codex.chat.thread_reuse_miss", {
					storedThreadCount: this.conversationThreads.size,
					messageCount: messages.length,
					reasons: Object.fromEntries([...reuseMissReasons].sort(([left], [right]) => left.localeCompare(right))),
					noStoredThreads: this.conversationThreads.size === 0,
				});
			}
		}
		const inputMessages = activeTurn
			? continuationMatch!.messages
			: conversationTail ?? messages;
		const inputMode = activeTurn ? "tool-result" : conversationContinuation ? "user-turn" : "full";
		this.requestCount++;
		if (inputMode !== "full") {
			this.threadReuseCount++;
		}
		this.statusChanges.fire(this.status);
		const input = serializeCodexConversation(inputMessages, {
			maxTextChars: config.get("codexMaxInputChars", 600_000),
			maxToolResultChars: config.get("codexMaxToolResultChars", 12_000),
		});
		const reusedThread = activeTurn ?? conversationContinuation;
		const threadRuntimeKey = reusedThread?.runtimeKey ?? runtimeKey;
		const threadToolCatalogKey = reusedThread?.toolCatalogKey ?? toolCatalogKey;
		const threadCallableNames = reusedThread?.callableNames ?? dynamicToolSet.callableNames;
		const threadToolNamespaces = reusedThread?.toolNamespaces ?? dynamicToolSet.toolNamespaces;
		const threadToolSignatures = reusedThread?.toolSignatures ?? currentToolSignatures;
		const effectiveTools = intersectCodexThreadTools(
			threadCallableNames,
			threadToolNamespaces,
			threadToolSignatures,
			dynamicToolSet.callableNames,
			currentToolSignatures
		);
		const toolCatalogChanged = Boolean(reusedThread && threadToolCatalogKey !== toolCatalogKey);

		this.logSink?.log("codex.chat.start", {
			model: model.id,
			messageCount: messages.length,
			inputChars: input.text.length,
			originalInputChars: input.originalTextChars,
			includedMessageCount: input.includedMessageCount,
			omittedMessageCount: input.omittedMessageCount,
			truncatedMessageCount: input.truncatedMessageCount,
			truncatedToolResultCount: input.truncatedToolResultCount,
			imageCount: input.images.length,
			omittedImageCount: input.omittedImageCount,
			outerToolCount: options.tools?.length ?? 0,
			vsCodeToolCount: dynamicToolSet.callableNames.size,
			deferredVsCodeToolCount: dynamicToolSet.deferredNames.size,
			skippedVsCodeToolCount: dynamicToolSet.skippedNames.length,
			modelOptionKeys: Object.keys(options.modelOptions ?? {}).sort(),
			copilotConversationIdPresent: copilotConversationId !== undefined,
			copilotTurnIndex,
			effort,
			summary,
			sandbox,
			approvalPolicy,
			planType: account.planType,
			continuation: Boolean(activeTurn),
			continuationCallId: continuationMatch?.callId,
			inputMode,
			toolSchemaChars: JSON.stringify(dynamicToolSet.specs).length,
			eagerToolSchemaChars: JSON.stringify(dynamicToolSet.specs.filter(tool => tool.type === "function")).length,
		});

		let threadId: string;
		let bridge: CodexTurnBridge;
		if (activeTurn) {
			bridge = activeTurn.bridge;
			threadId = bridge.threadId;
			this.logSink?.log("codex.chat.turn_resumed", {
				threadId,
				turnId: bridge.turnId,
				callId: continuationMatch!.callId,
			});
		} else if (conversationContinuation) {
			threadId = conversationContinuation.threadId;
			this.logSink?.log("codex.chat.thread_reused", {
				threadId,
				inputMode,
				inputChars: input.text.length,
				strategy: conversationMatchStrategy,
				copilotConversationMatched,
				matchedUserMessages,
				toolCatalogChanged,
				threadToolCount: threadCallableNames.size,
				currentToolCount: dynamicToolSet.callableNames.size,
				callableToolCount: effectiveTools.callableNames.size,
			});
			bridge = this.createTurnBridge(threadId);
		} else {
			const thread = await this.client.request<CodexThreadStartResponse>("thread/start", {
				model: model.model || model.id,
				cwd,
				approvalPolicy,
				sandbox,
				developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
				ephemeral: config.get<boolean>("codexEphemeralThreads", true) !== false,
				...(dynamicToolSet.specs.length > 0 ? { dynamicTools: dynamicToolSet.specs } : {}),
				...(serviceTier ? { serviceTier } : {}),
			});
			threadId = thread.thread.id;
			bridge = this.createTurnBridge(threadId);
		}
		if (!activeTurn && effectiveTools.callableNames.size > 0) {
			this.dynamicToolContexts.set(threadId, {
				callableNames: effectiveTools.callableNames,
				toolNamespaces: effectiveTools.toolNamespaces,
				delegate: call => bridge.delegate(call),
			});
		}
		const segmentStartedAt = Date.now();
		let keepBridge = false;
		try {
			const outcome = activeTurn
				? await bridge.resume(
					new Map(continuationMatches.map(match => [
						match.callId,
						convertCodexToolResult(match.result, config.get("codexMaxToolResultChars", 12_000)),
					])),
					progress,
					token
				)
				: await bridge.start({
					threadId,
					input: [
						{ type: "text", text: input.text, text_elements: [] },
						...input.images.map(url => ({ type: "image", url })),
					],
					effort,
					summary: ["auto", "concise", "detailed", "none"].includes(summary) ? summary : "auto",
					...(serviceTier ? { serviceTier } : {}),
				}, progress, token);
			if (outcome.kind === "delegated") {
				const active: ActiveCodexToolTurn = {
					bridge,
					modelId: model.id,
					runtimeKey: threadRuntimeKey,
					toolCatalogKey: threadToolCatalogKey,
					callableNames: threadCallableNames,
					toolNamespaces: threadToolNamespaces,
					toolSignatures: threadToolSignatures,
					createdAt: Date.now(),
					processGeneration: this.client.generation,
				};
				for (const call of bridge.pendingCalls) {
					this.activeToolTurns.set(call.callId, active);
				}
				keepBridge = true;
				this.logSink?.log("codex.chat.tool_delegated", {
					threadId,
					turnId: bridge.turnId,
					tool: outcome.call.tool,
					callId: outcome.call.callId,
					toolCount: bridge.pendingCalls.length,
					tools: bridge.pendingCalls.map(call => call.tool),
					durationMs: Date.now() - segmentStartedAt,
					totalDurationMs: Date.now() - bridge.startedAt,
					sameTurn: true,
				});
				return;
			}
			const completed = outcome.completed;
			if (completed.turn.status === "failed") {
				throw new Error(completed.turn.error?.message || "Codex turn failed");
			}
			if (completed.turn.status === "interrupted" || token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}

			if (bridge.tokenUsage) {
				this.lastCacheHitPercent = bridge.tokenUsage.last.inputTokens > 0
					? bridge.tokenUsage.last.cachedInputTokens / bridge.tokenUsage.last.inputTokens * 100
					: undefined;
				const usage = {
					prompt_tokens: bridge.tokenUsage.last.inputTokens,
					completion_tokens: bridge.tokenUsage.last.outputTokens,
					total_tokens: bridge.tokenUsage.last.totalTokens,
					prompt_tokens_details: { cached_tokens: bridge.tokenUsage.last.cachedInputTokens },
				};
				progress.report(vscode.LanguageModelDataPart.text(JSON.stringify(usage), "usage"));
			}
			this.logSink?.log("codex.chat.completed", {
				threadId,
				turnId: bridge.turnId,
				model: model.id,
				durationMs: Date.now() - bridge.startedAt,
				segmentDurationMs: Date.now() - segmentStartedAt,
				finalTextChars: bridge.finalTextChars,
				segmentTextChars: bridge.segmentText.length,
				tokenUsage: bridge.tokenUsage,
				inputMode,
			});
			const finalText = bridge.segmentText;
			if (finalText.trim()) {
				this.rememberConversationThread({
					threadId,
					modelId: model.id,
					runtimeKey: threadRuntimeKey,
					toolCatalogKey: threadToolCatalogKey,
					callableNames: threadCallableNames,
					toolNamespaces: threadToolNamespaces,
					toolSignatures: threadToolSignatures,
					copilotConversationId,
					copilotTurnIndex,
					anchor: createCodexConversationAnchor(messages, finalText),
					lastUsedAt: Date.now(),
					processGeneration: this.client.generation,
				});
			}
			this.statusChanges.fire(this.status);
			this.refreshStatusIfStale();
		} finally {
			if (!keepBridge) {
				this.dynamicToolContexts.delete(threadId);
				bridge.dispose();
			}
		}
	}

	provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		value: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		return Promise.resolve(estimateCodexInputTokens(value));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const active of new Set(this.activeToolTurns.values())) {
			active.bridge.dispose();
		}
		this.activeToolTurns.clear();
		this.dynamicToolContexts.clear();
		this.conversationThreads.clear();
		this.client.dispose();
		this.modelChanges.dispose();
		this.statusChanges.dispose();
	}

	private pruneActiveToolTurns(): void {
		const oldestAllowed = Date.now() - CODEX_CONTINUATION_TTL_MS;
		for (const [callId, active] of this.activeToolTurns) {
			if (active.createdAt < oldestAllowed || active.processGeneration !== this.client.generation) {
				this.activeToolTurns.delete(callId);
				this.abandonActiveToolTurn(active);
			}
		}
		while (this.activeToolTurns.size > MAX_CODEX_CONTINUATIONS) {
			const oldestCallId = this.activeToolTurns.keys().next().value as string | undefined;
			if (!oldestCallId) {
				break;
			}
			const active = this.activeToolTurns.get(oldestCallId);
			this.activeToolTurns.delete(oldestCallId);
			if (active) {
				this.abandonActiveToolTurn(active);
			}
		}
	}

	private abandonActiveToolTurn(active: ActiveCodexToolTurn): void {
		for (const [callId, candidate] of this.activeToolTurns) {
			if (candidate === active) {
				this.activeToolTurns.delete(callId);
			}
		}
		this.dynamicToolContexts.delete(active.bridge.threadId);
		active.bridge.dispose();
		void active.bridge.interrupt().catch(error => {
			this.logSink?.logError("codex.chat.abandon_interrupt_failed", error, {
				threadId: active.bridge.threadId,
				turnId: active.bridge.turnId,
			});
		});
	}

	private createTurnBridge(threadId: string): CodexTurnBridge {
		return new CodexTurnBridge(this.client, threadId, this.logSink, bridge => {
			const active = [...this.activeToolTurns.values()].find(candidate => candidate.bridge === bridge);
			if (active) {
				this.logSink?.log("codex.chat.tool_timeout", {
					threadId: bridge.threadId,
					turnId: bridge.turnId,
				}, "warn");
				this.abandonActiveToolTurn(active);
			}
		});
	}

	private rememberConversationThread(conversation: CodexConversationThread): void {
		this.conversationThreads.set(conversation.threadId, conversation);
		this.pruneConversationThreads();
	}

	private pruneConversationThreads(): void {
		const oldestAllowed = Date.now() - CODEX_CONVERSATION_TTL_MS;
		for (const [threadId, conversation] of this.conversationThreads) {
			if (conversation.lastUsedAt < oldestAllowed || conversation.processGeneration !== this.client.generation) {
				this.conversationThreads.delete(threadId);
			}
		}
		while (this.conversationThreads.size > MAX_CODEX_CONVERSATIONS) {
			const oldest = [...this.conversationThreads.values()]
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
			if (!oldest) {
				break;
			}
			this.conversationThreads.delete(oldest.threadId);
		}
	}

	private mapKnownModels(): vscode.LanguageModelChatInformation[] {
		const config = this.getConfig();
		const contextLength = this.clampNumber(
			config.get("codexContextLength", DEFAULT_CODEX_CONTEXT_LENGTH),
			32_768,
			1_048_576,
			DEFAULT_CODEX_CONTEXT_LENGTH
		);
		const maxOutputTokens = this.clampNumber(
			config.get("codexMaxOutputTokens", DEFAULT_CODEX_MAX_OUTPUT_TOKENS),
			1_024,
			131_072,
			DEFAULT_CODEX_MAX_OUTPUT_TOKENS
		);
		return [...this.models.values()].map(model => mapCodexModelInformation(model, contextLength, maxOutputTokens));
	}

	private async requireSubscriptionAccount(): Promise<CodexChatGptAccount> {
		const cached = this.accountCache;
		if (
			cached
			&& cached.generation === this.client.generation
			&& cached.expiresAt > Date.now()
		) {
			return cached.account;
		}
		const account = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: true });
		if (!account.account) {
			throw new Error("Codex is not signed in. Run Local LLM: Sign In to Codex Subscription.");
		}
		if (account.account.type !== "chatgpt") {
			throw new Error(
				"Codex is authenticated with an API key or another provider. Sign in with ChatGPT before using the subscription model."
			);
		}
		this.cacheSubscriptionAccount(account.account);
		return account.account;
	}

	private cacheSubscriptionAccount(account: CodexChatGptAccount): void {
		this.accountCache = {
			account,
			generation: this.client.generation,
			expiresAt: Date.now() + CODEX_ACCOUNT_CACHE_TTL_MS,
		};
	}

	private refreshStatusIfStale(): void {
		if (Date.now() - this.lastStatusRefreshAt < CODEX_STATUS_REFRESH_INTERVAL_MS) {
			return;
		}
		void this.refreshStatus().catch(error => this.logSink?.logError("codex.status.background_failed", error));
	}

	private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
		const params = asRecord(request.params);
		const requestThreadId = typeof params.threadId === "string" ? params.threadId : "";
		const nativeToolsActive = this.dynamicToolContexts.has(requestThreadId);
		switch (request.method) {
			case "item/commandExecution/requestApproval": {
				if (nativeToolsActive) {
					this.logSink?.log("codex.internal_tool.declined", { threadId: requestThreadId, kind: "command" });
					return { decision: "decline" };
				}
				const command = typeof params.command === "string" ? params.command : "Unknown command";
				const reason = typeof params.reason === "string" ? params.reason : undefined;
				const choice = await vscode.window.showWarningMessage(
					"Codex requests permission to run a command.",
					{ modal: true, detail: truncate(`${command}${reason ? `\n\nReason: ${reason}` : ""}`) },
					"Allow Once",
					"Allow for Session",
					"Deny"
				);
				return { decision: choice === "Allow Once" ? "accept" : choice === "Allow for Session" ? "acceptForSession" : "decline" };
			}
			case "item/fileChange/requestApproval": {
				if (nativeToolsActive) {
					this.logSink?.log("codex.internal_tool.declined", { threadId: requestThreadId, kind: "fileChange" });
					return { decision: "decline" };
				}
				const reason = typeof params.reason === "string" ? params.reason : "Codex requests a file change outside current permissions.";
				const choice = await vscode.window.showWarningMessage(
					"Codex requests permission to change files.",
					{ modal: true, detail: truncate(reason) },
					"Allow Once",
					"Allow for Session",
					"Deny"
				);
				return { decision: choice === "Allow Once" ? "accept" : choice === "Allow for Session" ? "acceptForSession" : "decline" };
			}
			case "item/permissions/requestApproval": {
				if (nativeToolsActive) {
					this.logSink?.log("codex.internal_tool.declined", { threadId: requestThreadId, kind: "permissions" });
					return { permissions: {}, scope: "turn" };
				}
				const requested = asRecord(params.permissions);
				const reason = typeof params.reason === "string" ? params.reason : "Codex requests additional workspace permissions.";
				const choice = await vscode.window.showWarningMessage(
					"Codex requests additional permissions.",
					{ modal: true, detail: truncate(`${reason}\n\n${JSON.stringify(requested, null, 2)}`) },
					"Allow Once",
					"Allow for Session",
					"Deny"
				);
				if (choice === "Deny" || !choice) {
					return { permissions: {}, scope: "turn" };
				}
				const permissions: Record<string, unknown> = {};
				if (requested.network) {
					permissions.network = requested.network;
				}
				if (requested.fileSystem) {
					permissions.fileSystem = requested.fileSystem;
				}
				return { permissions, scope: choice === "Allow for Session" ? "session" : "turn" };
			}
			case "item/tool/call":
				return this.handleDynamicToolCall(params);
			default:
				throw new CodexAppServerError(`Unsupported Codex interaction: ${request.method}`, -32601);
		}
	}

	private handleDynamicToolCall(params: Record<string, unknown>): Promise<CodexDynamicToolCallResponse> | CodexDynamicToolCallResponse {
		const threadId = typeof params.threadId === "string" ? params.threadId : "";
		const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
		const callId = typeof params.callId === "string" ? params.callId : "";
		const tool = typeof params.tool === "string" ? params.tool : "";
		const namespace = params.namespace;
		const context = this.dynamicToolContexts.get(threadId);
		const actualNamespace = typeof namespace === "string" ? namespace : null;
		const expectedNamespace = context?.toolNamespaces.get(tool) ?? null;
		if (
			!context
			|| !callId
			|| !tool
			|| !context.callableNames.has(tool)
			|| actualNamespace !== expectedNamespace
		) {
			return {
				contentItems: [{ type: "inputText", text: `VS Code tool is unavailable: ${tool || "unknown"}` }],
				success: false,
			};
		}
		const input = asRecord(params.arguments);
		return context.delegate({ callId, tool, input, turnId });
	}

	private waitForLogin(loginId: string): Promise<CodexLoginCompletedParams> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				disposable.dispose();
				reject(new Error("Timed out waiting for ChatGPT sign-in"));
			}, 5 * 60_000);
			const disposable = this.client.onNotification(notification => {
				if (notification.method !== "account/login/completed") {
					return;
				}
				const params = notification.params as CodexLoginCompletedParams;
				if (params.loginId !== loginId) {
					return;
				}
				clearTimeout(timer);
				disposable.dispose();
				resolve(params);
			});
		});
	}

	private selectRateLimit(response: CodexRateLimitsResponse) {
		return response.rateLimitsByLimitId?.codex ?? response.rateLimits;
	}

	private setStatus(status: CodexProviderStatus): CodexProviderStatus {
		if (
			status.state !== this.status.state ||
			status.summary !== this.status.summary ||
			status.usage !== this.status.usage
		) {
			this.status = status;
			this.statusChanges.fire(status);
		}
		return this.status;
	}

	private isEnabled(): boolean {
		return this.getConfig().get<boolean>("enableCodexSubscription", true) !== false;
	}

	private getConfig(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration("llamacpp");
	}

	private formatPlan(plan: string): string {
		return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "ChatGPT";
	}

	private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value)
			? Math.max(min, Math.min(max, Math.floor(value)))
			: fallback;
	}
}
