
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelResponsePart,
    Progress,
} from "vscode";
import { BaseChatModelProvider, DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_OUTPUT_TOKENS } from "./base-provider";
import { convertMessages, convertTools, validateRequest, type ToolResultMode } from "./utils";
import { LlamaLogSink } from "./logger";
import type { OpenAIChatMessage } from "./types";

type ThinkingMode = "off" | "light" | "balanced" | "deep" | "auto";
type ToolResultModeConfig = "auto" | "tool" | "user";

const DEFAULT_SERVER_URL = "http://localhost:8000";

interface LlamaCppModelInfo {
    id: string;
    aliases?: string[];
    contextLength?: number;
    meta?: {
        n_ctx_train?: number;
        [key: string]: unknown;
    };
}

interface ModelListCacheEntry {
    serverUrl: string;
    apiKeyPresent: boolean;
    fetchedAt: number;
    models: LlamaCppModelInfo[];
}

interface ModelListInflightEntry {
    serverUrl: string;
    apiKeyPresent: boolean;
    promise: Promise<LlamaCppModelInfo[]>;
}

interface RuntimeContextCacheEntry {
    serverUrl: string;
    apiKeyPresent: boolean;
    fetchedAt: number;
    contextLength: number;
}

export interface LlamaChatTurnMetrics {
    requestId: string;
    modelId: string;
    durationMs: number;
    queueWaitMs: number;
    firstTokenLatencyMs?: number;
    emittedParts: number;
    outputChars: number;
    thinkingChars: number;
    estimatedOutputTokens: number;
    tokensPerSecond?: number;
    retriedAfterOverflow: boolean;
}

export interface LlamaChatContextUsageMetrics {
    requestId: string;
    modelId: string;
    attemptNo: number;
    contextLength: number;
    inputBudget: number;
    softInputTarget: number;
    hardInputTarget: number;
    messageTokensBeforeCompact: number;
    messageTokensAfterCompact: number;
    messageCountBeforeCompact: number;
    messageCountAfterCompact: number;
    toolTokens: number;
    replyReserveTokens: number;
    cappedTools: number;
    autoCompacted: boolean;
    hardCompacted: boolean;
    estimatedUsedTokens: number;
    estimatedFreeTokens: number;
    estimatedUsagePercent: number;
}

interface PreparedMessagesForBudget {
    messages: OpenAIChatMessage[];
    initialTokenEstimate: number;
    finalTokenEstimate: number;
    initialMessageCount: number;
    finalMessageCount: number;
    autoCompacted: boolean;
    hardCompacted: boolean;
    hardTarget: number;
}

interface ChatRequestSlotLease {
    release: () => void;
    waitMs: number;
}

interface ChatRequestQueueWaiter {
    requestId: string;
    queuedAt: number;
    resolve: (lease: ChatRequestSlotLease) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
}

/**
 * Chat model provider for Llama.cpp servers.
 * Implements the VS Code language model chat provider interface for Llama.cpp compatible APIs.
 * Handles model discovery, chat responses, and streaming from local Llama.cpp instances.
 *
 */
export class LlamaCppChatModelProvider extends BaseChatModelProvider {
    private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;
    private readonly _onDidUpdateContextUsage = new vscode.EventEmitter<LlamaChatContextUsageMetrics>();
    readonly onDidUpdateContextUsage = this._onDidUpdateContextUsage.event;
    private readonly _onDidCompleteChatTurn = new vscode.EventEmitter<LlamaChatTurnMetrics>();
    readonly onDidCompleteChatTurn = this._onDidCompleteChatTurn.event;
    private modelListCache: ModelListCacheEntry | undefined;
    private modelListInflight: ModelListInflightEntry | undefined;
    private runtimeContextCache: RuntimeContextCacheEntry | undefined;
    private activeChatRequests = 0;
    private readonly chatRequestQueue: ChatRequestQueueWaiter[] = [];

    /**
     * Creates a new Llama.cpp chat model provider.
     * Initializes the provider with secret storage and user agent for API requests.
     *
     * @param secrets - VS Code secret storage for storing server URL and API key.
     * @param userAgent - User agent string to include in HTTP requests.
     */
    constructor(
        secrets: vscode.SecretStorage,
        private readonly userAgent: string,
        private readonly logger?: LlamaLogSink
    ) {
        super(secrets);
    }

    refreshLanguageModelChatInformation(): void {
        this.modelListCache = undefined;
        this.runtimeContextCache = undefined;
        this.log("models.refresh.requested");
        this._onDidChangeLanguageModelChatInformation.fire();
    }

    private getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration("llamacpp");
    }

    private log(event: string, data?: unknown): void {
        this.logger?.log(event, data);
    }

    private logError(event: string, error: unknown, data?: unknown): void {
        this.logger?.logError(event, error, data);
    }

    private cloneForLog(value: unknown): unknown {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return String(value);
        }
    }

    private redactHeaders(headers: Record<string, string>): Record<string, string> {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === "authorization") {
                next[key] = "[redacted]";
            } else {
                next[key] = value;
            }
        }
        return next;
    }

    private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
        const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
        return Math.min(max, Math.max(min, n));
    }

    private clampInt(value: unknown, min: number, max: number, fallback: number): number {
        const n = Number.isInteger(value) ? (value as number) : fallback;
        return Math.min(max, Math.max(min, n));
    }

    private normalizeServerUrl(url: string): string {
        const trimmed = url.trim().replace(/\/+$/, "");
        return trimmed || DEFAULT_SERVER_URL;
    }

    private getExplicitConfiguredServerUrl(): string | undefined {
        const inspected = this.getConfig().inspect<string>("serverUrl");
        const candidates = [
            inspected?.workspaceFolderValue,
            inspected?.workspaceValue,
            inspected?.globalValue,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
                return this.normalizeServerUrl(candidate);
            }
        }

        return undefined;
    }

    private getExplicitConfiguredContextLength(): number | undefined {
        const inspected = this.getConfig().inspect<number>("contextLength");
        const candidates = [
            inspected?.workspaceFolderValue,
            inspected?.workspaceValue,
            inspected?.globalValue,
        ];

        for (const candidate of candidates) {
            if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
                continue;
            }
            return this.clampInt(candidate, 4096, 262144, DEFAULT_CONTEXT_LENGTH);
        }

        return undefined;
    }

    private parsePositiveInt(value: unknown): number | undefined {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return Math.floor(value);
        }
        if (typeof value === "string") {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed) && parsed > 0) {
                return Math.floor(parsed);
            }
        }
        return undefined;
    }

    private getServerReportedModelContextLength(model: LlamaCppModelInfo): number | undefined {
        const meta = model.meta;
        const candidates: unknown[] = [
            model.contextLength,
            meta?.["n_ctx_runtime"],
            meta?.["n_ctx"],
            meta?.["num_ctx"],
            meta?.["context_length"],
            meta?.["max_context_length"],
            meta?.n_ctx_train,
        ];

        for (const candidate of candidates) {
            const parsed = this.parsePositiveInt(candidate);
            if (parsed !== undefined) {
                return this.clampInt(parsed, 4096, 262144, DEFAULT_CONTEXT_LENGTH);
            }
        }

        return undefined;
    }

    private resolveModelContextLength(model: LlamaCppModelInfo, runtimeContextLength?: number): number {
        const explicitConfigured = this.getExplicitConfiguredContextLength();
        if (explicitConfigured !== undefined) {
            return explicitConfigured;
        }

        if (runtimeContextLength !== undefined) {
            return this.clampInt(runtimeContextLength, 4096, 262144, DEFAULT_CONTEXT_LENGTH);
        }

        const serverReported = this.getServerReportedModelContextLength(model);
        if (serverReported !== undefined) {
            return serverReported;
        }

        return this.getConfiguredContextLength();
    }

    private resolveRuntimeContextLengthForRequest(
        model: LanguageModelChatInformation,
        runtimeContextLength?: number
    ): number {
        const explicitConfigured = this.getExplicitConfiguredContextLength();
        if (explicitConfigured !== undefined) {
            return explicitConfigured;
        }

        if (runtimeContextLength !== undefined) {
            return this.clampInt(runtimeContextLength, 4096, 262144, DEFAULT_CONTEXT_LENGTH);
        }

        const advertisedContext = this.parsePositiveInt(model.maxInputTokens + model.maxOutputTokens);
        if (advertisedContext !== undefined) {
            return this.clampInt(advertisedContext, 4096, 262144, DEFAULT_CONTEXT_LENGTH);
        }

        return this.getConfiguredContextLength();
    }

    private getConfiguredContextLength(): number {
        return this.clampInt(this.getConfig().get("contextLength", DEFAULT_CONTEXT_LENGTH), 4096, 262144, DEFAULT_CONTEXT_LENGTH);
    }

    private getConfiguredMaxOutputTokens(): number {
        return this.clampInt(
            this.getConfig().get("maxOutputTokensCap", DEFAULT_MAX_OUTPUT_TOKENS),
            128,
            32768,
            DEFAULT_MAX_OUTPUT_TOKENS
        );
    }

    private getModelListCacheTtlMs(): number {
        return this.clampInt(this.getConfig().get("modelListCacheTtlMs", 30000), 0, 600000, 30000);
    }

    private getCachePromptEnabled(): boolean {
        return this.getConfig().get<boolean>("cachePrompt", true) !== false;
    }

    private getRequestQueueTimeoutMs(): number {
        return this.clampInt(this.getConfig().get("requestQueueTimeoutMs", 1200000), 0, 1200000, 1200000);
    }

    private getMaxToolResultChars(): number {
        return this.clampInt(this.getConfig().get("maxToolResultChars", 24000), 0, 1000000, 24000);
    }

    private getMaxLoggedStreamChunkChars(): number {
        return this.clampInt(this.getConfig().get("maxLoggedStreamChunkChars", 4096), 0, 100000, 4096);
    }

    private resolveModelFamily(modelId: string): string {
        const configured = String(this.getConfig().get("modelFamily", "llama") ?? "llama").trim().toLowerCase();
        if (configured && configured !== "auto") {
            return configured;
        }

        const lower = modelId.toLowerCase();
        if (lower.includes("llama")) {
            return "llama";
        }
        return "llama";
    }

    private normalizeThinkingMode(value: unknown): ThinkingMode {
        const mode = typeof value === "string" ? value.toLowerCase().trim() : "auto";
        if (mode === "off" || mode === "light" || mode === "balanced" || mode === "deep" || mode === "auto") {
            return mode;
        }
        return "auto";
    }

    private resolveReasoningBudget(mode: ThinkingMode, configuredBudget: number): number {
        switch (mode) {
            case "off":
                return 0;
            case "light":
                return 512;
            case "balanced":
                return 2048;
            case "deep":
                return 8192;
            case "auto":
            default:
                return configuredBudget;
        }
    }

    private normalizeToolResultMode(value: unknown): ToolResultModeConfig {
        const mode = typeof value === "string" ? value.toLowerCase().trim() : "auto";
        if (mode === "auto" || mode === "tool" || mode === "user") {
            return mode;
        }
        return "auto";
    }

    private isThinkingResponsePart(part: unknown): boolean {
        if (!part || typeof part !== "object") {
            return false;
        }
        const ctorName = (part as { constructor?: { name?: string } }).constructor?.name;
        if (ctorName === "LanguageModelThinkingPart") {
            return true;
        }

        const candidate = part as Record<string, unknown>;
        if (typeof candidate["thinking"] === "string") {
            return true;
        }
        if (typeof candidate["text"] === "string" && candidate["metadata"] !== undefined && candidate["mimeType"] === undefined) {
            return true;
        }
        return false;
    }

    private getThinkingPartText(part: unknown): string {
        if (!part || typeof part !== "object") {
            return "";
        }
        const candidate = part as Record<string, unknown>;
        if (typeof candidate["text"] === "string") {
            return candidate["text"];
        }
        if (typeof candidate["thinking"] === "string") {
            return candidate["thinking"];
        }
        if (typeof candidate["value"] === "string" && this.isThinkingResponsePart(part)) {
            return candidate["value"];
        }
        return "";
    }

    private isToolRoleCompatibilityError(status: number, text: string): boolean {
        if (status !== 400 && status !== 422) {
            return false;
        }

        const lower = (text || "").toLowerCase();
        return (
            lower.includes("jinja") ||
            lower.includes("chat template") ||
            lower.includes("must alternate") ||
            (lower.includes("unsupported") && lower.includes("tool")) ||
            (lower.includes("role") && lower.includes("tool")) ||
            (lower.includes("invalid") && lower.includes("tool_call_id"))
        );
    }

    private estimateOpenAiMessageTokens(messages: OpenAIChatMessage[]): number {
        try {
            return Math.ceil(JSON.stringify(messages).length / 4);
        } catch {
            return 0;
        }
    }

    private contentToText(content: unknown): string {
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            return content
                .map(part => {
                    if (typeof part === "string") {
                        return part;
                    }
                    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
                        return (part as { text: string }).text;
                    }
                    return "";
                })
                .join("\n");
        }
        return "";
    }

    private compactSummaryTextForMessage(message: OpenAIChatMessage): string {
        if (message.role === "tool") {
            const toolName = typeof message.name === "string" && message.name.trim().length > 0
                ? message.name.trim()
                : "tool";
            const size = typeof message.content === "string" ? message.content.length : 0;
            return `[tool_result ${toolName}] ${size} chars omitted`;
        }

        if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const names = message.tool_calls
                .map(call => call.function?.name)
                .filter((name): name is string => typeof name === "string" && name.length > 0);
            if (names.length > 0) {
                const shown = names.slice(0, 3).join(", ");
                const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
                return `[tool_calls] ${shown}${extra}`;
            }
            return `[tool_calls] ${message.tool_calls.length}`;
        }

        return this.contentToText(message.content);
    }

    private truncateToolResultContent(content: string, maxChars: number): { content: string; truncatedChars: number } {
        if (maxChars <= 0 || content.length <= maxChars) {
            return { content, truncatedChars: 0 };
        }

        const truncatedChars = content.length - maxChars;
        return {
            content: `${content.slice(0, maxChars)}\n\n[tool result truncated: ${truncatedChars} chars omitted]`,
            truncatedChars,
        };
    }

    private truncateToolResultMessages(
        messages: OpenAIChatMessage[],
        maxChars: number,
        requestId: string
    ): OpenAIChatMessage[] {
        if (maxChars <= 0) {
            return messages;
        }

        let truncatedMessages = 0;
        let omittedChars = 0;
        const nextMessages = messages.map(message => {
            const content = message.content;
            if (typeof content !== "string") {
                return message;
            }

            const isToolResult = message.role === "tool" || (message.role === "user" && content.includes("[tool_result"));
            if (!isToolResult || content.length <= maxChars) {
                return message;
            }

            const truncated = this.truncateToolResultContent(content, maxChars);
            truncatedMessages += 1;
            omittedChars += truncated.truncatedChars;
            return { ...message, content: truncated.content };
        });

        if (truncatedMessages > 0) {
            this.log("chat.tool_results.truncated", {
                requestId,
                maxChars,
                truncatedMessages,
                omittedChars,
            });
        }

        return nextMessages;
    }

    private compactOpenAiMessages(
        messages: OpenAIChatMessage[],
        tokenBudget: number,
        keepLastCount: number,
        label: string
    ): OpenAIChatMessage[] {
        if (messages.length <= 2) {
            return messages;
        }

        const systems = messages.filter(m => m.role === "system");
        const nonSystem = messages.filter(m => m.role !== "system");

        if (nonSystem.length === 0) {
            return systems;
        }

        const keepLast = Math.min(nonSystem.length, Math.max(1, keepLastCount));
        const head = nonSystem.slice(0, Math.max(0, nonSystem.length - keepLast));
        let tail = nonSystem.slice(Math.max(0, nonSystem.length - keepLast));

        const summaryLines: string[] = [];
        for (const msg of head.slice(-24)) {
            const text = this.compactSummaryTextForMessage(msg).replace(/\s+/g, " ").trim();
            if (!text) {
                continue;
            }
            const clipped = text.length > 220 ? `${text.slice(0, 220)}...` : text;
            summaryLines.push(`- ${msg.role}: ${clipped}`);
        }

        const summaryText =
            summaryLines.length > 0
                ? `${label}:\n${summaryLines.join("\n")}`
                : `${label}: prior turns were compacted to fit model context.`;

        const compacted: OpenAIChatMessage[] = [...systems, { role: "system", content: summaryText }, ...tail];

        while (this.estimateOpenAiMessageTokens(compacted) > tokenBudget && tail.length > 2) {
            tail = tail.slice(1);
            compacted.splice(systems.length + 1, compacted.length - (systems.length + 1), ...tail);
        }

        if (this.estimateOpenAiMessageTokens(compacted) > tokenBudget) {
            for (const message of compacted) {
                if (typeof message.content === "string" && message.content.length > 1200) {
                    message.content = `${message.content.slice(0, 1200)}...`;
                }
            }
        }

        return compacted;
    }

    private isContextOverflowError(status: number, text: string): boolean {
        if (status !== 400 && status !== 413) {
            return false;
        }

        const lower = (text || "").toLowerCase();
        return (
            lower.includes("context") ||
            lower.includes("token") ||
            lower.includes("too long") ||
            lower.includes("exceed")
        );
    }

    private async sendChatCompletion(
        serverUrl: string,
        headers: Record<string, string>,
        requestBody: Record<string, unknown>,
        timeoutMs: number,
        token: CancellationToken
    ): Promise<Response> {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
        const onCancel = token.onCancellationRequested(() => controller.abort());

        try {
            return await fetch(`${serverUrl}/v1/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutHandle);
            onCancel.dispose();
        }
    }

    private acquireChatRequestSlot(
        requestId: string,
        queueTimeoutMs: number,
        token: CancellationToken
    ): Promise<ChatRequestSlotLease> {
        if (token.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }

        if (this.activeChatRequests === 0) {
            this.activeChatRequests += 1;
            this.log("chat.queue.acquired", {
                requestId,
                waitMs: 0,
                queueLength: this.chatRequestQueue.length,
            });
            return Promise.resolve({
                waitMs: 0,
                release: () => this.releaseChatRequestSlot(requestId),
            });
        }

        const queuedAt = Date.now();
        this.log("chat.queue.wait", {
            requestId,
            activeChatRequests: this.activeChatRequests,
            queueLength: this.chatRequestQueue.length + 1,
            queueTimeoutMs,
        });

        return new Promise<ChatRequestSlotLease>((resolve, reject) => {
            let settled = false;
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            let cancellationSubscription: vscode.Disposable | undefined;

            const removeWaiter = (waiter: ChatRequestQueueWaiter): void => {
                const index = this.chatRequestQueue.indexOf(waiter);
                if (index !== -1) {
                    this.chatRequestQueue.splice(index, 1);
                }
            };

            const cleanup = (): void => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = undefined;
                }
                cancellationSubscription?.dispose();
                cancellationSubscription = undefined;
            };

            const waiter: ChatRequestQueueWaiter = {
                requestId,
                queuedAt,
                cleanup,
                resolve: lease => {
                    if (settled) {
                        lease.release();
                        return;
                    }
                    settled = true;
                    cleanup();
                    const waitMs = Date.now() - queuedAt;
                    this.log("chat.queue.acquired", {
                        requestId,
                        waitMs,
                        queueLength: this.chatRequestQueue.length,
                    });
                    resolve({
                        waitMs,
                        release: lease.release,
                    });
                },
                reject: error => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    cleanup();
                    reject(error);
                },
            };

            cancellationSubscription = token.onCancellationRequested(() => {
                removeWaiter(waiter);
                waiter.reject(new vscode.CancellationError());
            });

            if (queueTimeoutMs > 0) {
                timeoutHandle = setTimeout(() => {
                    removeWaiter(waiter);
                    waiter.reject(new Error(`Timed out waiting ${queueTimeoutMs}ms for local llama.cpp request slot`));
                }, queueTimeoutMs);
            }

            this.chatRequestQueue.push(waiter);
        });
    }

    private releaseChatRequestSlot(requestId: string): void {
        this.activeChatRequests = Math.max(0, this.activeChatRequests - 1);
        this.log("chat.queue.released", {
            requestId,
            queueLength: this.chatRequestQueue.length,
        });
        this.drainChatRequestQueue();
    }

    private drainChatRequestQueue(): void {
        if (this.activeChatRequests > 0) {
            return;
        }

        const waiter = this.chatRequestQueue.shift();
        if (!waiter) {
            return;
        }

        this.activeChatRequests += 1;
        waiter.resolve({
            waitMs: Date.now() - waiter.queuedAt,
            release: () => this.releaseChatRequestSlot(waiter.requestId),
        });
    }

    private async captureRawStream(
        stream: ReadableStream<Uint8Array>,
        requestId: string,
        token: CancellationToken
    ): Promise<void> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let chunkIndex = 0;
        const maxLoggedStreamChunkChars = this.getMaxLoggedStreamChunkChars();

        try {
            while (!token.isCancellationRequested) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                const text = decoder.decode(value, { stream: true });
                const truncated = maxLoggedStreamChunkChars > 0 && text.length > maxLoggedStreamChunkChars;
                this.log("chat.stream.chunk", {
                    requestId,
                    chunkIndex,
                    byteLength: value.byteLength,
                    textLength: text.length,
                    truncated,
                    text: maxLoggedStreamChunkChars > 0
                        ? text.slice(0, maxLoggedStreamChunkChars)
                        : undefined,
                });
                chunkIndex += 1;
            }

            const tail = decoder.decode();
            if (tail) {
                const truncated = maxLoggedStreamChunkChars > 0 && tail.length > maxLoggedStreamChunkChars;
                this.log("chat.stream.chunk", {
                    requestId,
                    chunkIndex,
                    byteLength: 0,
                    textLength: tail.length,
                    truncated,
                    text: maxLoggedStreamChunkChars > 0
                        ? tail.slice(0, maxLoggedStreamChunkChars)
                        : undefined,
                    tail: true,
                });
            }

            this.log("chat.stream.end", {
                requestId,
                chunkCount: chunkIndex,
                cancelled: token.isCancellationRequested,
            });
        } catch (error) {
            this.logError("chat.stream.capture_failed", error, { requestId, chunkIndex });
        } finally {
            reader.releaseLock();
        }
    }

    private getFreshCachedModels(serverUrl: string, apiKeyPresent: boolean, ttlMs: number): LlamaCppModelInfo[] | undefined {
        if (ttlMs <= 0 || !this.modelListCache) {
            return undefined;
        }

        if (this.modelListCache.serverUrl !== serverUrl || this.modelListCache.apiKeyPresent !== apiKeyPresent) {
            return undefined;
        }

        if (Date.now() - this.modelListCache.fetchedAt > ttlMs) {
            return undefined;
        }

        return this.modelListCache.models;
    }

    private getAnyCachedModels(serverUrl: string, apiKeyPresent: boolean): LlamaCppModelInfo[] | undefined {
        if (!this.modelListCache) {
            return undefined;
        }

        if (this.modelListCache.serverUrl !== serverUrl || this.modelListCache.apiKeyPresent !== apiKeyPresent) {
            return undefined;
        }

        return this.modelListCache.models;
    }

    private cacheModels(serverUrl: string, apiKeyPresent: boolean, models: LlamaCppModelInfo[]): void {
        this.modelListCache = {
            serverUrl,
            apiKeyPresent,
            fetchedAt: Date.now(),
            models,
        };
    }

    private getFreshCachedRuntimeContextLength(
        serverUrl: string,
        apiKeyPresent: boolean,
        ttlMs: number
    ): number | undefined {
        if (ttlMs <= 0 || !this.runtimeContextCache) {
            return undefined;
        }

        if (
            this.runtimeContextCache.serverUrl !== serverUrl ||
            this.runtimeContextCache.apiKeyPresent !== apiKeyPresent
        ) {
            return undefined;
        }

        if (Date.now() - this.runtimeContextCache.fetchedAt > ttlMs) {
            return undefined;
        }

        return this.runtimeContextCache.contextLength;
    }

    private cacheRuntimeContextLength(serverUrl: string, apiKeyPresent: boolean, contextLength: number): void {
        this.runtimeContextCache = {
            serverUrl,
            apiKeyPresent,
            fetchedAt: Date.now(),
            contextLength: this.clampInt(contextLength, 4096, 262144, DEFAULT_CONTEXT_LENGTH),
        };
    }

    private async fetchRuntimeContextLength(serverUrl: string, apiKey?: string): Promise<number | undefined> {
        const headers: Record<string, string> = {
            "User-Agent": this.userAgent,
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        try {
            const response = await fetch(`${serverUrl}/slots`, {
                method: "GET",
                headers,
            });

            if (!response.ok) {
                this.log("models.runtime_context.slots_unavailable", {
                    endpoint: `${serverUrl}/slots`,
                    status: response.status,
                    statusText: response.statusText,
                });
                return undefined;
            }

            const body = (await response.json()) as unknown;
            const slotCandidates: number[] = [];

            if (Array.isArray(body)) {
                for (const slot of body) {
                    if (!slot || typeof slot !== "object") {
                        continue;
                    }
                    const slotObj = slot as Record<string, unknown>;
                    const direct = this.parsePositiveInt(slotObj["n_ctx"]);
                    if (direct !== undefined) {
                        slotCandidates.push(direct);
                    }
                    const params = slotObj["params"];
                    if (params && typeof params === "object") {
                        const nested = this.parsePositiveInt((params as Record<string, unknown>)["n_ctx"]);
                        if (nested !== undefined) {
                            slotCandidates.push(nested);
                        }
                    }
                }
            } else if (body && typeof body === "object") {
                const obj = body as Record<string, unknown>;
                const direct = this.parsePositiveInt(obj["n_ctx"]);
                if (direct !== undefined) {
                    slotCandidates.push(direct);
                }
            }

            if (slotCandidates.length === 0) {
                return undefined;
            }

            const runtimeContextLength = this.clampInt(
                Math.max(...slotCandidates),
                4096,
                262144,
                DEFAULT_CONTEXT_LENGTH
            );
            this.log("models.runtime_context.detected", {
                source: "slots",
                contextLength: runtimeContextLength,
            });
            return runtimeContextLength;
        } catch (error) {
            this.logError("models.runtime_context.failed", error, {
                endpoint: `${serverUrl}/slots`,
            });
            return undefined;
        }
    }

    private async getRuntimeContextLengthWithCache(
        serverUrl: string,
        apiKey: string | undefined,
        apiKeyPresent: boolean,
        ttlMs: number
    ): Promise<number | undefined> {
        const cached = this.getFreshCachedRuntimeContextLength(serverUrl, apiKeyPresent, ttlMs);
        if (cached !== undefined) {
            return cached;
        }

        const runtimeContextLength = await this.fetchRuntimeContextLength(serverUrl, apiKey);
        if (runtimeContextLength !== undefined) {
            this.cacheRuntimeContextLength(serverUrl, apiKeyPresent, runtimeContextLength);
        }
        return runtimeContextLength;
    }

    private async fetchModelsWithInflightCache(
        serverUrl: string,
        apiKey: string | undefined,
        apiKeyPresent: boolean
    ): Promise<LlamaCppModelInfo[]> {
        const currentInflight = this.modelListInflight;
        if (
            currentInflight &&
            currentInflight.serverUrl === serverUrl &&
            currentInflight.apiKeyPresent === apiKeyPresent
        ) {
            this.log("models.request.inflight_join", { serverUrl, apiKeyPresent });
            return currentInflight.promise;
        }

        const fetchPromise = this.fetchModels(serverUrl, apiKey).finally(() => {
            if (this.modelListInflight?.promise === fetchPromise) {
                this.modelListInflight = undefined;
            }
        });
        this.modelListInflight = {
            serverUrl,
            apiKeyPresent,
            promise: fetchPromise,
        };
        return fetchPromise;
    }

    private mapModelInfo(
        model: LlamaCppModelInfo,
        serverUrl: string,
        runtimeContextLength?: number
    ): LanguageModelChatInformation {
        const contextLength = this.resolveModelContextLength(model, runtimeContextLength);
        const maxOutputTokens = Math.min(this.getConfiguredMaxOutputTokens(), Math.max(128, contextLength - 1024));
        const maxInputTokens = Math.max(1, contextLength - maxOutputTokens);
        const maxTools = this.clampInt(this.getConfig().get("maxToolsPerRequest", 128), 0, 128, 128);
        const family = this.resolveModelFamily(model.id);

        const info: LanguageModelChatInformation & Record<string, unknown> = {
            id: model.id,
            name: model.id,
            tooltip: `Llama.cpp model: ${model.id}\nServer: ${serverUrl}\nContext: ${contextLength} tokens`,
            detail: `${family} / ctx ${contextLength}`,
            family,
            version: "1.0.0",
            maxInputTokens,
            maxOutputTokens,
            capabilities: {
                toolCalling: maxTools > 0,
                imageInput: false,
            },
        };

        // Some model pickers (for example Copilot's BYOK picker pipeline) check these non-typed flags.
        info.isUserSelectable = true;
        info.multiplierNumeric = 0;
        info.model_picker_enabled = true;

        return info;
    }

    /**
     * Provides information about available Llama.cpp models.
     * Fetches model list from the configured server and returns model information.
     *
     * @param options - Options for the request, including error suppression.
     * @param token - Cancellation token to abort the operation.
     * @returns Promise resolving to an array of available models.
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const serverUrl = await this.getServerUrl();
        const apiKey = await this.getApiKey(); // Optional
        const apiKeyPresent = Boolean(apiKey);
        const modelListCacheTtlMs = this.getModelListCacheTtlMs();
        const runtimeContextLength = await this.getRuntimeContextLengthWithCache(
            serverUrl,
            apiKey,
            apiKeyPresent,
            modelListCacheTtlMs
        );

        const cachedModels = this.getFreshCachedModels(serverUrl, apiKeyPresent, modelListCacheTtlMs);
        if (cachedModels) {
            const entries = cachedModels.map(model => this.mapModelInfo(model, serverUrl, runtimeContextLength));
            this.log("models.request.cache_hit", {
                serverUrl,
                count: entries.length,
                modelListCacheTtlMs,
                runtimeContextLength,
                models: entries.map(model => ({
                    id: model.id,
                    family: model.family,
                    maxInputTokens: model.maxInputTokens,
                    maxOutputTokens: model.maxOutputTokens,
                })),
            });
            return entries;
        }

        this.log("models.request.start", {
            serverUrl,
            hasApiKey: apiKeyPresent,
            silent: options.silent,
            cancelled: token.isCancellationRequested,
            modelListCacheTtlMs,
        });

        try {
            const models = await this.fetchModelsWithInflightCache(serverUrl, apiKey, apiKeyPresent);
            this.cacheModels(serverUrl, apiKeyPresent, models);
            const entries = models.map(model => this.mapModelInfo(model, serverUrl, runtimeContextLength));
            this.log("models.request.success", {
                serverUrl,
                count: models.length,
                runtimeContextLength,
                models: entries.map(model => ({
                    id: model.id,
                    family: model.family,
                    maxInputTokens: model.maxInputTokens,
                    maxOutputTokens: model.maxOutputTokens,
                    capabilities: model.capabilities,
                })),
            });
            return entries;
        } catch (err) {
            this.logError("models.request.failed", err, {
                serverUrl,
                silent: options.silent,
            });
            const staleModels = this.getAnyCachedModels(serverUrl, apiKeyPresent);
            if (staleModels) {
                const entries = staleModels.map(model => this.mapModelInfo(model, serverUrl, runtimeContextLength));
                this.log("models.request.stale_cache_fallback", {
                    serverUrl,
                    count: entries.length,
                });
                return entries;
            }
            if (!options.silent) {
                console.error("[Llama.cpp Provider] Failed to fetch models", err);
            }
            return []; // Return empty if failed or server not running
        }
    }

    /**
     * Provides a chat response from the Llama.cpp model.
     * Sends a chat completion request to the server and processes the streaming response.
     *
     * @param model - Information about the selected model.
     * @param messages - Array of chat messages for the conversation.
     * @param options - Options for the response generation.
     * @param progress - Progress callback to report response parts.
     * @param token - Cancellation token to abort the operation.
     * @returns Promise that resolves when the response is complete.
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        const serverUrl = await this.getServerUrl();
        const apiKey = await this.getApiKey();
        const apiKeyPresent = Boolean(apiKey);
        const cfg = this.getConfig();
        const requestId = randomUUID();
        const turnStartedAt = Date.now();

        let firstOutputAt: number | undefined;
        let emittedParts = 0;
        let outputChars = 0;
        let thinkingChars = 0;
        let emittedToolCallParts = 0;

        const runtimeContextLength = await this.getRuntimeContextLengthWithCache(
            serverUrl,
            apiKey,
            apiKeyPresent,
            this.getModelListCacheTtlMs()
        );
        const contextLength = this.resolveRuntimeContextLengthForRequest(model, runtimeContextLength);
        const contextUtil = this.clampNumber(cfg.get("contextUtilization", 0.85), 0.5, 0.95, 0.85);
        const hardContextUtil = this.clampNumber(cfg.get("hardContextUtilization", 0.72), 0.4, 0.9, 0.72);
        const keepLastTurns = this.clampInt(cfg.get("compactKeepLastTurns", 12), 2, 64, 12);
        const hardKeepLastTurns = this.clampInt(cfg.get("hardCompactKeepLastTurns", 6), 1, 32, 6);
        const maxOutputCap = this.getConfiguredMaxOutputTokens();
        const minReplyReserve = this.clampInt(cfg.get("minReplyReserveTokens", 1536), 256, 32768, 1536);
        const maxTools = this.clampInt(cfg.get("maxToolsPerRequest", 128), 0, 128, 128);
        const requestTimeoutMs = this.clampInt(cfg.get("requestTimeoutMs", 1200000), 10000, 1200000, 1200000);
        const requestQueueTimeoutMs = this.getRequestQueueTimeoutMs();
        const cachePrompt = this.getCachePromptEnabled();
        const maxToolResultChars = this.getMaxToolResultChars();
        const autoCompact = cfg.get<boolean>("autoCompact", true) !== false;
        const retryOnOverflow = cfg.get<boolean>("retryOnContextOverflow", true) !== false;
        const emptyResponseAutoRetry = cfg.get<boolean>("emptyResponseAutoRetry", true) !== false;
        const emptyResponseAutoRetryMaxAttempts = this.clampInt(
            cfg.get("emptyResponseAutoRetryMaxAttempts", 1),
            0,
            3,
            1
        );
        const configuredContinuationPrompt = String(
            cfg.get(
                "emptyResponseContinuationPrompt",
                "Continue from your previous response and complete the answer. Do not repeat already completed parts."
            ) ?? ""
        ).trim();
        const emptyResponseContinuationPrompt =
            configuredContinuationPrompt.length > 0
                ? configuredContinuationPrompt
                : "Continue from your previous response and complete the answer. Do not repeat already completed parts.";
        const thinkingMode = this.normalizeThinkingMode(cfg.get("thinkingMode", "auto"));
        const configuredReasoningBudget = this.clampInt(cfg.get("reasoningBudget", 2048), 0, 65536, 2048);
        const reasoningBudget = this.resolveReasoningBudget(thinkingMode, configuredReasoningBudget);
        const toolResultModeConfig = this.normalizeToolResultMode(cfg.get("toolResultMode", "auto"));

        this.log("chat.turn.start", {
            requestId,
            modelId: model.id,
            serverUrl,
            messageCount: messages.length,
            requestedModelOptions: this.cloneForLog(options.modelOptions),
            settings: {
                contextLength,
                contextUtil,
                hardContextUtil,
                keepLastTurns,
                hardKeepLastTurns,
                maxOutputCap,
                minReplyReserve,
                maxTools,
                requestTimeoutMs,
                requestQueueTimeoutMs,
                cachePrompt,
                maxToolResultChars,
                runtimeContextLength,
                autoCompact,
                retryOnOverflow,
                emptyResponseAutoRetry,
                emptyResponseAutoRetryMaxAttempts,
                emptyResponseContinuationPrompt,
                thinkingMode,
                configuredReasoningBudget,
                reasoningBudget,
                toolResultModeConfig,
            },
        });

        validateRequest(messages);
        const toolConfig = convertTools(options);
        const convertForMode = (mode: ToolResultMode): OpenAIChatMessage[] =>
            this.truncateToolResultMessages(
                convertMessages(messages, { toolResultMode: mode }),
                maxToolResultChars,
                requestId
            );

        const initialToolResultMode: ToolResultMode = toolResultModeConfig === "user" ? "user" : "tool";
        let activeToolResultMode: ToolResultMode = initialToolResultMode;

        const cappedToolConfig: ReturnType<typeof convertTools> = {
            ...toolConfig,
            tools: Array.isArray(toolConfig.tools) ? (maxTools > 0 ? toolConfig.tools.slice(0, maxTools) : []) : undefined,
        };

        if (Array.isArray(toolConfig.tools) && toolConfig.tools.length > maxTools) {
            console.warn(`[Llama.cpp Provider] Truncating tools from ${toolConfig.tools.length} to ${maxTools}`);
            this.log("chat.tools.truncated", {
                requestId,
                originalTools: toolConfig.tools.length,
                allowedTools: maxTools,
            });
        }

        const requestedMaxTokens = this.clampInt(
            options.modelOptions?.max_tokens,
            1,
            262144,
            Math.max(1, Math.min(model.maxOutputTokens, maxOutputCap))
        );
        const maxTokens = Math.max(1, Math.min(requestedMaxTokens, model.maxOutputTokens, maxOutputCap));
        const temperature = this.clampNumber(options.modelOptions?.temperature ?? 0.7, 0, 2, 0.7);

        const modelInputLimit = Math.max(1, contextLength);
        const inputBudget = Math.max(1, Math.floor(modelInputLimit * contextUtil));
        const toolTokenCount = this.estimateToolTokens(cappedToolConfig.tools);
        const replyReserve = Math.max(minReplyReserve, maxTokens);
        const softInputTarget = Math.max(1, inputBudget - replyReserve - toolTokenCount);

        this.log("chat.turn.budget", {
            requestId,
            modelInputLimit,
            inputBudget,
            toolTokenCount,
            replyReserve,
            softInputTarget,
            maxTokens,
            requestedMaxTokens,
            cappedTools: Array.isArray(cappedToolConfig.tools) ? cappedToolConfig.tools.length : 0,
        });

        const prepareMessagesForBudget = (sourceMessages: OpenAIChatMessage[]): PreparedMessagesForBudget => {
            let preparedMessages = sourceMessages;
            let messageTokenCount = this.estimateOpenAiMessageTokens(preparedMessages);
            const initialMessageCount = preparedMessages.length;
            const initialTokenEstimate = messageTokenCount;
            let autoCompacted = false;
            let hardCompacted = false;
            const hardTarget = Math.max(1, Math.floor(modelInputLimit * hardContextUtil) - replyReserve - toolTokenCount);

            this.log("chat.messages.initial", {
                requestId,
                tokenEstimate: messageTokenCount,
                messageCount: preparedMessages.length,
            });

            if (autoCompact && messageTokenCount > softInputTarget) {
                preparedMessages = this.compactOpenAiMessages(
                    preparedMessages,
                    softInputTarget,
                    keepLastTurns,
                    "Conversation summary (auto-compact)"
                );
                messageTokenCount = this.estimateOpenAiMessageTokens(preparedMessages);
                autoCompacted = true;
                this.log("chat.messages.auto_compact", {
                    requestId,
                    tokenEstimate: messageTokenCount,
                    messageCount: preparedMessages.length,
                    target: softInputTarget,
                });
            }

            if (messageTokenCount > softInputTarget) {
                preparedMessages = this.compactOpenAiMessages(
                    preparedMessages,
                    hardTarget,
                    hardKeepLastTurns,
                    "Conversation summary (hard compact)"
                );
                messageTokenCount = this.estimateOpenAiMessageTokens(preparedMessages);
                hardCompacted = true;
                this.log("chat.messages.hard_compact", {
                    requestId,
                    tokenEstimate: messageTokenCount,
                    messageCount: preparedMessages.length,
                    target: hardTarget,
                });
                if (messageTokenCount > hardTarget) {
                    this.log("chat.messages.compact_failed", {
                        requestId,
                        tokenEstimate: messageTokenCount,
                        hardTarget,
                    });
                    throw new Error("Conversation is still too large after compaction. Start a new chat or reduce history.");
                }
            }

            return {
                messages: preparedMessages,
                initialTokenEstimate,
                finalTokenEstimate: messageTokenCount,
                initialMessageCount,
                finalMessageCount: preparedMessages.length,
                autoCompacted,
                hardCompacted,
                hardTarget,
            };
        };

        const requestBody: Record<string, unknown> = {
            model: model.id,
            messages: [],
            stream: true,
            max_tokens: maxTokens,
            temperature,
        };

        requestBody.cache_prompt = cachePrompt;

        requestBody.reasoning_budget = reasoningBudget;
        requestBody.reasoning = {
            budget_tokens: reasoningBudget,
        };

        if (typeof options.modelOptions?.top_p === "number") {
            requestBody.top_p = this.clampNumber(options.modelOptions.top_p, 0, 1, 1);
        }

        if (typeof options.modelOptions?.top_k === "number") {
            requestBody.top_k = this.clampInt(options.modelOptions.top_k, 0, 1000, 40);
        }

        if (cappedToolConfig.tools) {
            requestBody.tools = cappedToolConfig.tools;
        }
        if (cappedToolConfig.tool_choice) {
            requestBody.tool_choice = cappedToolConfig.tool_choice;
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        type AttemptResult =
            | { ok: true; response: Response; retriedAfterOverflow: boolean; attemptNo: number }
            | {
                  ok: false;
                  status: number;
                  statusText: string;
                  errorText: string;
                  retriedAfterOverflow: boolean;
                  attemptNo: number;
              };

        let attemptCounter = 0;
        let latestContextUsage: LlamaChatContextUsageMetrics | undefined;
        const attemptRequest = async (sourceMessages: OpenAIChatMessage[]): Promise<AttemptResult> => {
            attemptCounter += 1;
            const attemptNo = attemptCounter;
            const prepared = prepareMessagesForBudget(sourceMessages);
            requestBody.messages = prepared.messages;

            const cappedTools = Array.isArray(cappedToolConfig.tools) ? cappedToolConfig.tools.length : 0;
            const estimatedUsedTokens = Math.max(0, prepared.finalTokenEstimate + toolTokenCount + replyReserve);
            const estimatedFreeTokens = Math.max(0, modelInputLimit - estimatedUsedTokens);
            const estimatedUsagePercent = Number(((estimatedUsedTokens / modelInputLimit) * 100).toFixed(1));

            latestContextUsage = {
                requestId,
                modelId: model.id,
                attemptNo,
                contextLength: modelInputLimit,
                inputBudget,
                softInputTarget,
                hardInputTarget: prepared.hardTarget,
                messageTokensBeforeCompact: prepared.initialTokenEstimate,
                messageTokensAfterCompact: prepared.finalTokenEstimate,
                messageCountBeforeCompact: prepared.initialMessageCount,
                messageCountAfterCompact: prepared.finalMessageCount,
                toolTokens: toolTokenCount,
                replyReserveTokens: replyReserve,
                cappedTools,
                autoCompacted: prepared.autoCompacted,
                hardCompacted: prepared.hardCompacted,
                estimatedUsedTokens,
                estimatedFreeTokens,
                estimatedUsagePercent,
            };
            this.log("chat.context.usage", latestContextUsage);
            this._onDidUpdateContextUsage.fire(latestContextUsage);

            this.log("chat.request.send", {
                requestId,
                attemptNo,
                endpoint: `${serverUrl}/v1/chat/completions`,
                timeoutMs: requestTimeoutMs,
                toolResultMode: activeToolResultMode,
                headers: this.redactHeaders(headers),
                requestBody: this.cloneForLog(requestBody),
            });

            let response: Response;
            const requestStartedAt = Date.now();
            try {
                response = await this.sendChatCompletion(serverUrl, headers, requestBody, requestTimeoutMs, token);
            } catch (error) {
                this.logError("chat.request.transport_error", error, {
                    requestId,
                    attemptNo,
                    timeoutMs: requestTimeoutMs,
                    cancelled: token.isCancellationRequested,
                });
                throw error;
            }

            this.log("chat.request.response", {
                requestId,
                attemptNo,
                status: response.status,
                statusText: response.statusText,
                durationMs: Date.now() - requestStartedAt,
            });

            let retriedAfterOverflow = false;

            if (!response.ok && retryOnOverflow) {
                const errText = await response.text();
                this.log("chat.request.error", {
                    requestId,
                    attemptNo,
                    status: response.status,
                    statusText: response.statusText,
                    errorText: errText,
                });
                if (this.isContextOverflowError(response.status, errText)) {
                    const hardTarget = Math.max(
                        1,
                        Math.floor(modelInputLimit * hardContextUtil) - replyReserve - toolTokenCount
                    );
                    const overflowMessages = this.compactOpenAiMessages(
                        prepared.messages,
                        hardTarget,
                        hardKeepLastTurns,
                        "Conversation summary (overflow retry)"
                    );
                    requestBody.messages = overflowMessages;

                    const overflowMessageTokens = this.estimateOpenAiMessageTokens(overflowMessages);
                    const overflowEstimatedUsedTokens = Math.max(0, overflowMessageTokens + toolTokenCount + replyReserve);
                    const overflowEstimatedFreeTokens = Math.max(0, modelInputLimit - overflowEstimatedUsedTokens);
                    const overflowEstimatedUsagePercent = Number(((overflowEstimatedUsedTokens / modelInputLimit) * 100).toFixed(1));

                    if (latestContextUsage) {
                        latestContextUsage = {
                            ...latestContextUsage,
                            messageTokensAfterCompact: overflowMessageTokens,
                            messageCountAfterCompact: overflowMessages.length,
                            hardInputTarget: hardTarget,
                            hardCompacted: true,
                            estimatedUsedTokens: overflowEstimatedUsedTokens,
                            estimatedFreeTokens: overflowEstimatedFreeTokens,
                            estimatedUsagePercent: overflowEstimatedUsagePercent,
                        };
                        this.log("chat.context.usage", latestContextUsage);
                        this._onDidUpdateContextUsage.fire(latestContextUsage);
                    }

                    this.log("chat.request.overflow_retry", {
                        requestId,
                        attemptNo,
                        hardTarget,
                        retryMessageCount: Array.isArray(requestBody.messages)
                            ? requestBody.messages.length
                            : undefined,
                        requestBody: this.cloneForLog(requestBody),
                    });

                    const retryStartedAt = Date.now();
                    try {
                        response = await this.sendChatCompletion(serverUrl, headers, requestBody, requestTimeoutMs, token);
                    } catch (error) {
                        this.logError("chat.request.overflow_retry_transport_error", error, {
                            requestId,
                            attemptNo,
                            timeoutMs: requestTimeoutMs,
                            cancelled: token.isCancellationRequested,
                        });
                        throw error;
                    }

                    this.log("chat.request.overflow_retry_response", {
                        requestId,
                        attemptNo,
                        status: response.status,
                        statusText: response.statusText,
                        durationMs: Date.now() - retryStartedAt,
                    });
                    retriedAfterOverflow = true;
                } else {
                    return {
                        ok: false,
                        status: response.status,
                        statusText: response.statusText,
                        errorText: errText,
                        retriedAfterOverflow,
                        attemptNo,
                    };
                }
            }

            if (!response.ok) {
                const errorText = await response.text();
                this.log("chat.request.final_error", {
                    requestId,
                    attemptNo,
                    status: response.status,
                    statusText: response.statusText,
                    errorText,
                    retriedAfterOverflow,
                });
                return {
                    ok: false,
                    status: response.status,
                    statusText: response.statusText,
                    errorText,
                    retriedAfterOverflow,
                    attemptNo,
                };
            }

            this.log("chat.request.success", {
                requestId,
                attemptNo,
                retriedAfterOverflow,
            });

            return { ok: true, response, retriedAfterOverflow, attemptNo };
        };

        let chatSlot: ChatRequestSlotLease | undefined;
        try {
            chatSlot = await this.acquireChatRequestSlot(requestId, requestQueueTimeoutMs, token);
        } catch (error) {
            this.logError("chat.queue.failed", error, { requestId, requestQueueTimeoutMs });
            throw error;
        }
        try {
            const runAttemptWithToolCompatibility = async (
                sourceMessages: OpenAIChatMessage[]
            ): Promise<{ attempt: Extract<AttemptResult, { ok: true }>; usedMessages: OpenAIChatMessage[] }> => {
                let attempt = await attemptRequest(sourceMessages);
                let usedMessages = sourceMessages;

                if (
                    !attempt.ok &&
                    toolResultModeConfig === "auto" &&
                    activeToolResultMode === "tool" &&
                    this.isToolRoleCompatibilityError(attempt.status, attempt.errorText)
                ) {
                    console.warn("[Llama.cpp Provider] Falling back to user-style tool results for compatibility");
                    this.log("chat.tool_result_mode.fallback", {
                        requestId,
                        from: "tool",
                        to: "user",
                        status: attempt.status,
                        statusText: attempt.statusText,
                        errorText: attempt.errorText,
                    });
                    activeToolResultMode = "user";
                    usedMessages = convertForMode(activeToolResultMode);
                    attempt = await attemptRequest(usedMessages);
                }

                if (!attempt.ok) {
                    const retryHint = attempt.retriedAfterOverflow
                        ? "\nRetry after automatic compaction did not fit context."
                        : "";
                    throw new Error(`Llama.cpp API error: ${attempt.status} ${attempt.statusText}\n${attempt.errorText}${retryHint}`);
                }

                return { attempt, usedMessages };
            };

            let continuationRetryCount = 0;
            let sourceMessages = convertForMode(activeToolResultMode);
            let finalAttempt: Extract<AttemptResult, { ok: true }> | undefined;

            while (true) {
                const { attempt, usedMessages } = await runAttemptWithToolCompatibility(sourceMessages);
                sourceMessages = usedMessages;

                if (!attempt.response.body) {
                    throw new Error("No response body from Llama.cpp API");
                }

                let roundOutputChars = 0;
                let roundThinkingChars = 0;
                let roundToolCallParts = 0;

                let responseBody = attempt.response.body;
                let streamLogTask: Promise<void> | undefined;
                if (this.logger?.shouldLogStreamChunks()) {
                    const [processingStream, loggingStream] = responseBody.tee();
                    responseBody = processingStream;
                    streamLogTask = this.captureRawStream(loggingStream, requestId, token);
                    this.log("chat.stream.capture_started", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                    });
                }

                const measuredProgress: Progress<LanguageModelResponsePart> = {
                    report: part => {
                        emittedParts += 1;
                        if (part instanceof vscode.LanguageModelTextPart) {
                            outputChars += part.value.length;
                            roundOutputChars += part.value.length;
                            if (part.value.length > 0 && firstOutputAt === undefined) {
                                firstOutputAt = Date.now();
                            }
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            emittedToolCallParts += 1;
                            roundToolCallParts += 1;
                        } else if (this.isThinkingResponsePart(part)) {
                            const thinkingText = this.getThinkingPartText(part);
                            thinkingChars += thinkingText.length;
                            roundThinkingChars += thinkingText.length;
                            if (thinkingText.length > 0 && firstOutputAt === undefined) {
                                firstOutputAt = Date.now();
                            }
                        }
                        progress.report(part);
                    },
                };

                await this.processStreamingResponse(responseBody, measuredProgress, token);
                await streamLogTask;

                if (
                    roundOutputChars === 0 &&
                    roundToolCallParts === 0 &&
                    !token.isCancellationRequested &&
                    emptyResponseAutoRetry &&
                    continuationRetryCount < emptyResponseAutoRetryMaxAttempts
                ) {
                    continuationRetryCount += 1;
                    this.log("chat.response.empty_output_autoretry", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        toolResultMode: activeToolResultMode,
                        continuationRetryCount,
                        emptyResponseAutoRetryMaxAttempts,
                        emittedParts,
                        emittedToolCallParts,
                        thinkingChars,
                    });

                    sourceMessages = [
                        ...sourceMessages,
                        {
                            role: "user",
                            content: emptyResponseContinuationPrompt,
                        },
                    ];
                    continue;
                }

                if (roundOutputChars === 0 && roundToolCallParts === 0 && !token.isCancellationRequested) {
                    const fallbackText =
                        "No text response was produced by the model for this turn. See the latest log for details.";
                    measuredProgress.report(new vscode.LanguageModelTextPart(fallbackText));
                    this.log("chat.response.empty_output_fallback", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        toolResultMode: activeToolResultMode,
                        continuationRetryCount,
                        emittedParts,
                        emittedToolCallParts,
                        thinkingChars,
                    });
                } else if (roundOutputChars === 0 && roundToolCallParts > 0) {
                    this.log("chat.response.empty_output_with_tool_calls", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        toolResultMode: activeToolResultMode,
                        continuationRetryCount,
                        emittedParts,
                        emittedToolCallParts,
                        thinkingChars,
                        roundThinkingChars,
                    });
                }

                finalAttempt = attempt;
                break;
            }

            if (!finalAttempt) {
                throw new Error("No final chat attempt result available");
            }

            const finishedAt = Date.now();
            const firstTokenLatencyMs = firstOutputAt === undefined ? undefined : firstOutputAt - turnStartedAt;
            const generationMs = firstOutputAt === undefined ? 0 : Math.max(1, finishedAt - firstOutputAt);
            const estimatedOutputTokens = Math.ceil(Math.max(0, outputChars) / 4);
            const tokensPerSecond = generationMs > 0 ? Number((estimatedOutputTokens / (generationMs / 1000)).toFixed(2)) : undefined;
            const queueWaitMs = chatSlot.waitMs;

            const metrics: LlamaChatTurnMetrics = {
                requestId,
                modelId: model.id,
                durationMs: finishedAt - turnStartedAt,
                queueWaitMs,
                firstTokenLatencyMs,
                emittedParts,
                outputChars,
                thinkingChars,
                estimatedOutputTokens,
                tokensPerSecond,
                retriedAfterOverflow: finalAttempt.retriedAfterOverflow,
            };

            this.log("chat.turn.complete", {
                requestId,
                attemptNo: finalAttempt.attemptNo,
                retriedAfterOverflow: finalAttempt.retriedAfterOverflow,
                continuationRetryCount,
                toolResultMode: activeToolResultMode,
                contextUsage: latestContextUsage,
                metrics,
            });

            this._onDidCompleteChatTurn.fire(metrics);
        } catch (err) {
            this.logError("chat.turn.failed", err, { requestId });
            console.error("[Llama.cpp Provider] Chat request failed", err);
            throw err;
        } finally {
            chatSlot?.release();
        }
    }

    /**
     * Retrieves the configured server URL from secrets.
     * Falls back to default localhost URL if not configured.
     *
     * @returns Promise resolving to the server URL.
     */
    private async getServerUrl(): Promise<string> {
        const configuredUrl = this.getExplicitConfiguredServerUrl();
        if (configuredUrl) {
            return configuredUrl;
        }

        const secretUrl = (await this.secrets.get("llamacpp.serverUrl")) || "";
        return this.normalizeServerUrl(secretUrl || DEFAULT_SERVER_URL);
    }

    /**
     * Retrieves the optional API key from secrets.
     * Returns undefined if no API key is configured.
     *
     * @returns Promise resolving to the API key or undefined.
     */
    private async getApiKey(): Promise<string | undefined> {
        return await this.secrets.get("llamacpp.apiKey");
    }

    /**
     * Fetches the list of available models from the Llama.cpp server.
     * Makes a GET request to the /v1/models endpoint.
     *
     * @param serverUrl - The base URL of the Llama.cpp server.
     * @param apiKey - Optional API key for authentication.
     * @returns Promise resolving to an array of model objects.
     */
    private async fetchModels(serverUrl: string, apiKey?: string): Promise<LlamaCppModelInfo[]> {
        const headers: Record<string, string> = {
             "User-Agent": this.userAgent
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        this.log("models.http.send", {
            endpoint: `${serverUrl}/v1/models`,
            headers: this.redactHeaders(headers),
        });

        const response = await fetch(`${serverUrl}/v1/models`, {
            method: "GET",
            headers,
        });

        this.log("models.http.response", {
            status: response.status,
            statusText: response.statusText,
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as { data?: unknown[]; models?: unknown[] };
        const rawModels = Array.isArray(data.data) && data.data.length > 0 ? data.data : data.models ?? [];

        return rawModels.flatMap(item => {
            if (!item || typeof item !== "object") {
                return [];
            }

            const obj = item as Record<string, unknown>;
            const modelMeta = obj.meta && typeof obj.meta === "object" ? (obj.meta as Record<string, unknown>) : undefined;
            const id =
                typeof obj.id === "string"
                    ? obj.id
                    : typeof obj.model === "string"
                      ? obj.model
                      : typeof obj.name === "string"
                        ? obj.name
                        : undefined;

            if (!id || id.trim().length === 0) {
                return [];
            }

            const aliases = Array.isArray(obj.aliases)
                ? obj.aliases.filter((alias): alias is string => typeof alias === "string")
                : undefined;
            const contextLengthCandidates: unknown[] = [
                obj["n_ctx_runtime"],
                obj["n_ctx"],
                obj["num_ctx"],
                obj["context_length"],
                obj["max_context_length"],
                obj["n_ctx_train"],
                modelMeta?.["n_ctx_runtime"],
                modelMeta?.["n_ctx"],
                modelMeta?.["num_ctx"],
                modelMeta?.["context_length"],
                modelMeta?.["max_context_length"],
                modelMeta?.["n_ctx_train"],
            ];

            let contextLength: number | undefined;
            for (const candidate of contextLengthCandidates) {
                const parsed = this.parsePositiveInt(candidate);
                if (parsed !== undefined) {
                    contextLength = this.clampInt(parsed, 4096, 262144, DEFAULT_CONTEXT_LENGTH);
                    break;
                }
            }

            const meta = modelMeta as LlamaCppModelInfo["meta"] | undefined;

            return [{ id: id.trim(), aliases, contextLength, meta }];
        });
    }
}
