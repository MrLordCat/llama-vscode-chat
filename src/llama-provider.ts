
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelResponsePart,
    Progress,
} from "vscode";
import { BaseChatModelProvider, DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_OUTPUT_TOKENS } from "./base-provider";
import {
    CONFIG_SECTION,
    DEFAULT_LOCAL_REASONING_BUDGET,
    DEEPSEEK_CONTEXT_LENGTH,
    DEEPSEEK_MAX_OUTPUT_TOKENS,
    DEFAULT_SERVER_URL,
} from "./constants";
import { calculateContextBudget, estimateContextUsage } from "./context/context-budget";
import { compactMessages } from "./context/message-compaction";
import { resolveOutputTokenBudget } from "./context/output-budget";
import { calculatePromptCacheUsage, estimateChatTokenUsage, type ChatTokenUsage } from "./context/usage";
import { convertMessages, convertTools, validateRequest, type ToolCallingMode, type ToolResultMode } from "./utils";
import { LlamaLogSink } from "./logger";
import { buildMemoryQuery, injectSharedMemoryContext } from "./memory/prompt";
import type { SharedMemoryContextProvider, SharedMemoryPromptContext } from "./memory/types";
import {
    createModelSources,
    encodeProviderModelId,
    normalizeServerUrl,
    parseProviderModelId,
    resolveModelFamily,
    type ChatModelSource,
    type LlamaCppModelInfo,
} from "./model-sources/source-routing";
import {
    createReasoningConfigurationSchema,
    resolveReasoningBudget,
    resolveRequestThinkingMode,
} from "./reasoning";
import { buildChatCompletionRequest } from "./request/chat-request";
import { SerialRequestQueue, type ChatRequestSlotLease } from "./transport/request-queue";
import {
    getChatCompletionsEndpoint,
    getModelsEndpoint,
    isDeepSeekEndpoint,
    OpenAIHttpTransport,
} from "./transport/openai-http";
import type { OpenAIChatMessage } from "./types";

type ToolResultModeConfig = "auto" | "tool" | "user";
type ToolCallingModeConfig = "classic" | "apiDirect";

const MAX_CONTEXT_LENGTH = 1048576;
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
    promptTokens: number;
    cachedPromptTokens?: number;
    promptCacheHitPercent?: number;
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
    private readonly modelListCache = new Map<string, ModelListCacheEntry>();
    private readonly modelListInflight = new Map<string, ModelListInflightEntry>();
    private readonly runtimeContextCache = new Map<string, RuntimeContextCacheEntry>();
    private readonly chatRequestQueue: SerialRequestQueue;
    private readonly httpTransport = new OpenAIHttpTransport();

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
        private readonly logger?: LlamaLogSink,
        private readonly sharedMemory?: SharedMemoryContextProvider
    ) {
        super(secrets);
        this.chatRequestQueue = new SerialRequestQueue(event => {
            const { type, ...data } = event;
            this.log(`chat.queue.${type}`, data);
        });
    }

    refreshLanguageModelChatInformation(): void {
        this.modelListCache.clear();
        this.runtimeContextCache.clear();
        this.log("models.refresh.requested");
        this._onDidChangeLanguageModelChatInformation.fire();
    }

    private getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(CONFIG_SECTION);
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

    private summarizeContentForLog(content: OpenAIChatMessage["content"]): {
        kind: "empty" | "text" | "parts";
        textChars: number;
        partCount?: number;
        imageParts?: number;
    } {
        if (typeof content === "string") {
            return { kind: "text", textChars: content.length };
        }

        if (Array.isArray(content)) {
            let textChars = 0;
            let imageParts = 0;
            for (const part of content) {
                if (part.type === "text" && typeof part.text === "string") {
                    textChars += part.text.length;
                } else if (part.type === "image_url") {
                    imageParts += 1;
                }
            }
            return {
                kind: "parts",
                textChars,
                partCount: content.length,
                imageParts,
            };
        }

        return { kind: "empty", textChars: 0 };
    }

    private summarizeMessagesForLog(messages: unknown): Record<string, unknown> {
        if (!Array.isArray(messages)) {
            return { count: 0 };
        }

        const roles: Record<string, number> = {};
        let textChars = 0;
        let contentParts = 0;
        let imageParts = 0;
        let toolCallCount = 0;
        let toolResultCount = 0;
        const tailRoles: string[] = [];

        for (const item of messages) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const msg = item as OpenAIChatMessage;
            const role = typeof msg.role === "string" ? msg.role : "unknown";
            roles[role] = (roles[role] ?? 0) + 1;
            tailRoles.push(role);
            if (tailRoles.length > 8) {
                tailRoles.shift();
            }

            const contentSummary = this.summarizeContentForLog(msg.content);
            textChars += contentSummary.textChars;
            contentParts += contentSummary.partCount ?? 0;
            imageParts += contentSummary.imageParts ?? 0;

            if (Array.isArray(msg.tool_calls)) {
                toolCallCount += msg.tool_calls.length;
            }
            if (role === "tool" || typeof msg.tool_call_id === "string") {
                toolResultCount += 1;
            }
        }

        return {
            count: messages.length,
            roles,
            tailRoles,
            textChars,
            contentParts,
            imageParts,
            toolCallCount,
            toolResultCount,
        };
    }

    private summarizeToolsForLog(tools: unknown): Record<string, unknown> {
        if (!Array.isArray(tools)) {
            return { count: 0 };
        }

        const names = tools
            .map(tool => {
                if (!tool || typeof tool !== "object") {
                    return undefined;
                }
                const fn = (tool as Record<string, unknown>)["function"];
                if (!fn || typeof fn !== "object") {
                    return undefined;
                }
                const name = (fn as Record<string, unknown>)["name"];
                return typeof name === "string" ? name : undefined;
            })
            .filter((name): name is string => typeof name === "string");

        return {
            count: tools.length,
            names: names.slice(0, 32),
            omittedNames: Math.max(0, names.length - 32),
        };
    }

    private summarizeRequestBodyForLog(requestBody: Record<string, unknown>): Record<string, unknown> {
        return {
            model: requestBody.model,
            stream: requestBody.stream,
            max_tokens: requestBody.max_tokens,
            temperature: requestBody.temperature,
            top_p: requestBody.top_p,
            top_k: requestBody.top_k,
            cache_prompt: requestBody.cache_prompt,
            tool_choice: requestBody.tool_choice,
            thinking: requestBody.thinking,
            reasoning_effort: requestBody.reasoning_effort,
            reasoning_budget: requestBody.reasoning_budget,
            reasoning: requestBody.reasoning,
            messages: this.summarizeMessagesForLog(requestBody.messages),
            tools: this.summarizeToolsForLog(requestBody.tools),
        };
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
        return normalizeServerUrl(url);
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
            return this.clampInt(candidate, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        return undefined;
    }

    private getConfiguredLocalServerUrl(): string {
        return this.normalizeServerUrl(
            String(this.getConfig().get("localServerUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL)
        );
    }

    private getConfiguredLocalContextLength(): number {
        return this.clampInt(
            this.getConfig().get("localContextLength", DEFAULT_CONTEXT_LENGTH),
            4096,
            MAX_CONTEXT_LENGTH,
            DEFAULT_CONTEXT_LENGTH
        );
    }

    private getSourceCacheKey(serverUrl: string, apiKeyPresent: boolean): string {
        return `${this.normalizeServerUrl(serverUrl)}|key=${apiKeyPresent ? "1" : "0"}`;
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
                return this.clampInt(parsed, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
            }
        }

        return undefined;
    }

    private resolveModelContextLength(
        model: LlamaCppModelInfo,
        runtimeContextLength?: number,
        source?: ChatModelSource
    ): number {
        if (source?.contextLengthOverride !== undefined) {
            return this.clampInt(source.contextLengthOverride, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        if (!source) {
            const explicitConfigured = this.getExplicitConfiguredContextLength();
            if (explicitConfigured !== undefined) {
                return explicitConfigured;
            }
        }

        const family = this.resolveModelFamily(model.id, source?.familyOverride);

        if (family === "deepseek") {
            const deepseekCandidates: number[] = [];

            if (runtimeContextLength !== undefined) {
                deepseekCandidates.push(runtimeContextLength);
            }

            const serverReported = this.getServerReportedModelContextLength(model);
            if (serverReported !== undefined) {
                deepseekCandidates.push(serverReported);
            }

            // DeepSeek V4 models expose 1M context in official docs; keep a 1M floor
            // when endpoint metadata is missing or reports a lower compatibility value.
            deepseekCandidates.push(DEEPSEEK_CONTEXT_LENGTH);

            return this.clampInt(
                Math.max(...deepseekCandidates),
                4096,
                MAX_CONTEXT_LENGTH,
                DEFAULT_CONTEXT_LENGTH
            );
        }

        if (runtimeContextLength !== undefined) {
            return this.clampInt(runtimeContextLength, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        const serverReported = this.getServerReportedModelContextLength(model);
        if (serverReported !== undefined) {
            return serverReported;
        }

        if (source?.contextLengthFallback !== undefined) {
            return this.clampInt(source.contextLengthFallback, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        return this.getConfiguredContextLength();
    }

    private resolveRuntimeContextLengthForRequest(
        model: LanguageModelChatInformation,
        runtimeContextLength?: number,
        source?: ChatModelSource
    ): number {
        if (source?.contextLengthOverride !== undefined) {
            return this.clampInt(source.contextLengthOverride, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        if (!source) {
            const explicitConfigured = this.getExplicitConfiguredContextLength();
            if (explicitConfigured !== undefined) {
                return explicitConfigured;
            }
        }

        if (runtimeContextLength !== undefined) {
            return this.clampInt(runtimeContextLength, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        const advertisedContext = this.parsePositiveInt(model.maxInputTokens + model.maxOutputTokens);
        if (advertisedContext !== undefined) {
            return this.clampInt(advertisedContext, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        if (source?.contextLengthFallback !== undefined) {
            return this.clampInt(source.contextLengthFallback, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        return this.getConfiguredContextLength();
    }

    private getConfiguredContextLength(): number {
        return this.clampInt(this.getConfig().get("contextLength", DEFAULT_CONTEXT_LENGTH), 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
    }

    private getConfiguredMaxOutputTokens(): number {
        return this.clampInt(
            this.getConfig().get("maxOutputTokensCap", DEFAULT_MAX_OUTPUT_TOKENS),
            128,
            393216,
            DEFAULT_MAX_OUTPUT_TOKENS
        );
    }

    private resolveAdvertisedMaxOutputTokens(
        family: string,
        contextLength: number,
        configuredOutputCap: number
    ): number {
        const contextBound = Math.max(128, contextLength - 1024);

        if (family === "deepseek") {
            return Math.min(
                Math.max(configuredOutputCap, DEEPSEEK_MAX_OUTPUT_TOKENS),
                contextBound
            );
        }

        const localContextShareCap = Math.max(2048, Math.floor(contextLength * 0.25));
        const localDefaultCap = Math.min(32768, localContextShareCap);
        return Math.min(configuredOutputCap, contextBound, localDefaultCap);
    }

    private getModelListCacheTtlMs(): number {
        return this.clampInt(this.getConfig().get("modelListCacheTtlMs", 30000), 0, 600000, 30000);
    }

    private getModelDiscoveryTimeoutMs(): number {
        return this.clampInt(this.getConfig().get("modelDiscoveryTimeoutMs", 20000), 3000, 120000, 20000);
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

    private getSummarizeLargeToolResults(): boolean {
        return this.getConfig().get<boolean>("summarizeLargeToolResults", true) !== false;
    }

    private getSanitizeToolResultArtifacts(): boolean {
        return this.getConfig().get<boolean>("sanitizeToolResultArtifacts", true) !== false;
    }

    private getMaxLoggedStreamChunkChars(): number {
        return this.clampInt(this.getConfig().get("maxLoggedStreamChunkChars", 4096), 0, 100000, 4096);
    }

    private resolveModelFamily(modelId: string, familyOverride?: string): string {
        const configured = String(this.getConfig().get("modelFamily", "llama") ?? "llama").trim().toLowerCase();
        return resolveModelFamily(modelId, familyOverride, configured);
    }

    private normalizeToolResultMode(value: unknown): ToolResultModeConfig {
        const mode = typeof value === "string" ? value.toLowerCase().trim() : "auto";
        if (mode === "auto" || mode === "tool" || mode === "user") {
            return mode;
        }
        return "auto";
    }

    private normalizeToolCallingMode(value: unknown): ToolCallingModeConfig {
        const mode = typeof value === "string" ? value.toLowerCase().trim() : "classic";
        if (mode === "classic" || mode === "apidirect") {
            return mode === "apidirect" ? "apiDirect" : "classic";
        }
        return "classic";
    }

    private isDeepSeekServer(serverUrl: string): boolean {
        return isDeepSeekEndpoint(serverUrl);
    }

    private getChatCompletionsEndpoint(serverUrl: string): string {
        return getChatCompletionsEndpoint(serverUrl);
    }

    private getModelsEndpoint(serverUrl: string): string {
        return getModelsEndpoint(serverUrl);
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

    /**
     * Rough token estimation for OpenAI-format messages.
     * Handles multimodal (image_url) content with a capped per-image estimate
     * instead of raw base64 length, which would be wildly inflated.
     */
    private estimateOpenAiMessageTokens(messages: OpenAIChatMessage[]): number {
        try {
            let charCount = 0;
            for (const msg of messages) {
                charCount += (msg.role?.length || 0) + (msg.name?.length || 0) + (msg.tool_call_id?.length || 0);
                if (typeof msg.content === "string") {
                    charCount += msg.content.length;
                } else if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === "text" && typeof part.text === "string") {
                            charCount += part.text.length;
                        } else if (part.type === "image_url" && part.image_url?.url) {
                            // Conservative per-image token estimate.
                            // For "auto" detail OpenAI charges ~85 base + resize cost;
                            // DeepSeek converts to visual tokens in a similar range.
                            // We estimate 255 tokens (≈1020 chars) as a safe upper bound.
                            charCount += 1020;
                        }
                    }
                }
                if (Array.isArray(msg.tool_calls)) {
                    try {
                        charCount += JSON.stringify(msg.tool_calls).length;
                    } catch {
                        // Ignore serialization errors.
                    }
                }
            }
            return Math.max(1, Math.ceil(charCount / 4));
        } catch {
            return 0;
        }
    }

    /**
     * Save user-attached images to temporary files and return modified messages
     * with text instructions pointing to the saved files.
     * Used when the model provider doesn't support inline image_url content blocks.
     */
    private saveUserImagesToTemp(
        messages: readonly LanguageModelChatMessage[],
        requestId: string
    ): LanguageModelChatMessage[] {
        const tempDir = path.join(os.tmpdir(), "llama-vscode-chat", requestId);
        fs.mkdirSync(tempDir, { recursive: true });

        let imageIndex = 0;
        return messages.map(msg => {
            if (msg.role !== vscode.LanguageModelChatMessageRole.User) {
                return msg;
            }

            let hasImages = false;
            const newContent: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart)[] = [];

            for (const part of msg.content ?? []) {
                if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
                    hasImages = true;
                    const ext = part.mimeType.split("/")[1] || "png";
                    imageIndex += 1;
                    const filename = `attached-image-${String(imageIndex).padStart(3, "0")}.${ext}`;
                    const filePath = path.join(tempDir, filename);
                    try {
                        fs.writeFileSync(filePath, part.data);
                        this.log("chat.image.saved_to_temp", {
                            requestId,
                            filePath,
                            mimeType: part.mimeType,
                            byteLength: part.data.byteLength,
                        });
                        newContent.push(new vscode.LanguageModelTextPart(
                            `[Attached image #${imageIndex} saved to: ${filePath} — use the view_image tool to examine this image]`
                        ));
                    } catch (err) {
                        this.logError("chat.image.save_failed", err, {
                            requestId,
                            filePath,
                            mimeType: part.mimeType,
                        });
                        newContent.push(new vscode.LanguageModelTextPart(
                            `[Attached image #${imageIndex} (${part.mimeType}, ${(part.data.byteLength / 1024).toFixed(1)} KB) — could not save to temp, use view_image tool if available]`
                        ));
                    }
                } else {
                    newContent.push(part);
                }
            }

            if (hasImages) {
                return {
                    ...msg,
                    content: newContent,
                } as LanguageModelChatMessage;
            }
            return msg;
        });
    }

    private truncateToolResultContent(content: string, maxChars: number): { content: string; truncatedChars: number } {
        if (maxChars <= 0 || content.length <= maxChars) {
            return { content, truncatedChars: 0 };
        }

        const truncatedChars = content.length - maxChars;
        if (this.getSummarizeLargeToolResults()) {
            const normalized = content.replace(/\r\n/g, "\n");
            const trimmed = normalized.trimStart();
            const lineCount = normalized.length > 0 ? normalized.split("\n").length : 0;
            const format = trimmed.startsWith("{") || trimmed.startsWith("[") ? "json-like" : "text";
            const previewLimit = Math.min(600, maxChars);
            const compactPreview = normalized.slice(0, previewLimit).replace(/\s+/g, " ").trim();
            const preview = compactPreview.length > 0
                ? `\npreview: ${compactPreview.slice(0, 400)}${compactPreview.length > 400 ? "..." : ""}`
                : "";
            return {
                content:
                    `[tool result summarized: original=${content.length} chars, lines=${lineCount}, omitted=${truncatedChars} chars, format=${format}]${preview}`,
                truncatedChars,
            };
        }

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

        let sanitizedMessages = 0;
        let truncatedMessages = 0;
        let omittedChars = 0;
        const nextMessages = messages.map(message => {
            const content = message.content;
            if (typeof content !== "string") {
                return message;
            }

            const isToolResult = message.role === "tool" || (message.role === "user" && content.includes("[tool_result"));
            if (!isToolResult) {
                return message;
            }

            let nextContent = content;
            if (this.getSanitizeToolResultArtifacts()) {
                // Remove transient transport metadata sometimes appended to tool output text.
                const cleaned = nextContent
                    .replace(/\{\s*"\$mid"\s*:\s*\d+\s*,\s*"mimeType"\s*:\s*"cache_control"\s*,\s*"data"\s*:\s*"[A-Za-z0-9+/=]+"\s*\}/g, "")
                    .replace(/\n{3,}/g, "\n\n")
                    .trimEnd();
                if (cleaned !== nextContent) {
                    nextContent = cleaned;
                    sanitizedMessages += 1;
                }
            }

            if (maxChars <= 0 || nextContent.length <= maxChars) {
                if (nextContent !== content) {
                    return { ...message, content: nextContent };
                }
                return message;
            }

            const truncated = this.truncateToolResultContent(nextContent, maxChars);
            truncatedMessages += 1;
            omittedChars += truncated.truncatedChars;
            return { ...message, content: truncated.content };
        });

        if (sanitizedMessages > 0) {
            this.log("chat.tool_results.sanitized", {
                requestId,
                sanitizedMessages,
            });
        }

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
        return compactMessages(messages, {
            tokenBudget,
            keepLastCount,
            label,
            estimateTokens: candidate => this.estimateOpenAiMessageTokens(candidate),
        });
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
        return this.httpTransport.postChatCompletion(serverUrl, headers, requestBody, timeoutMs, token);
    }

    private acquireChatRequestSlot(
        requestId: string,
        queueTimeoutMs: number,
        token: CancellationToken
    ): Promise<ChatRequestSlotLease> {
        return this.chatRequestQueue.acquire(
            requestId,
            queueTimeoutMs,
            token,
            () => new vscode.CancellationError()
        );
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
        const cached = this.modelListCache.get(this.getSourceCacheKey(serverUrl, apiKeyPresent));
        if (ttlMs <= 0 || !cached) {
            return undefined;
        }

        if (cached.serverUrl !== serverUrl || cached.apiKeyPresent !== apiKeyPresent) {
            return undefined;
        }

        if (Date.now() - cached.fetchedAt > ttlMs) {
            return undefined;
        }

        return cached.models;
    }

    private getAnyCachedModels(serverUrl: string, apiKeyPresent: boolean): LlamaCppModelInfo[] | undefined {
        const cached = this.modelListCache.get(this.getSourceCacheKey(serverUrl, apiKeyPresent));
        if (!cached) {
            return undefined;
        }

        if (cached.serverUrl !== serverUrl || cached.apiKeyPresent !== apiKeyPresent) {
            return undefined;
        }

        return cached.models;
    }

    private cacheModels(serverUrl: string, apiKeyPresent: boolean, models: LlamaCppModelInfo[]): void {
        this.modelListCache.set(this.getSourceCacheKey(serverUrl, apiKeyPresent), {
            serverUrl,
            apiKeyPresent,
            fetchedAt: Date.now(),
            models,
        });
    }

    private getFreshCachedRuntimeContextLength(
        serverUrl: string,
        apiKeyPresent: boolean,
        ttlMs: number
    ): number | undefined {
        const cached = this.runtimeContextCache.get(this.getSourceCacheKey(serverUrl, apiKeyPresent));
        if (ttlMs <= 0 || !cached) {
            return undefined;
        }

        if (cached.serverUrl !== serverUrl || cached.apiKeyPresent !== apiKeyPresent) {
            return undefined;
        }

        if (Date.now() - cached.fetchedAt > ttlMs) {
            return undefined;
        }

        return cached.contextLength;
    }

    private cacheRuntimeContextLength(serverUrl: string, apiKeyPresent: boolean, contextLength: number): void {
        this.runtimeContextCache.set(this.getSourceCacheKey(serverUrl, apiKeyPresent), {
            serverUrl,
            apiKeyPresent,
            fetchedAt: Date.now(),
            contextLength: this.clampInt(contextLength, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH),
        });
    }

    private async fetchRuntimeContextLength(serverUrl: string, apiKey?: string): Promise<number | undefined> {
        if (!this.shouldProbeRuntimeSlots(serverUrl)) {
            this.log("models.runtime_context.slots_skipped", {
                endpoint: `${serverUrl}/slots`,
                reason: "provider_not_llamacpp",
            });
            return undefined;
        }

        const headers: Record<string, string> = {
            "User-Agent": this.userAgent,
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        try {
            const response = await this.fetchWithTimeout(
                `${serverUrl}/slots`,
                {
                method: "GET",
                headers,
                },
                this.getModelDiscoveryTimeoutMs()
            );

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
                MAX_CONTEXT_LENGTH,
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
        const cacheKey = this.getSourceCacheKey(serverUrl, apiKeyPresent);
        const currentInflight = this.modelListInflight.get(cacheKey);
        if (currentInflight && currentInflight.serverUrl === serverUrl && currentInflight.apiKeyPresent === apiKeyPresent) {
            this.log("models.request.inflight_join", { serverUrl, apiKeyPresent });
            return currentInflight.promise;
        }

        const fetchPromise = this.fetchModels(serverUrl, apiKey).finally(() => {
            if (this.modelListInflight.get(cacheKey)?.promise === fetchPromise) {
                this.modelListInflight.delete(cacheKey);
            }
        });
        this.modelListInflight.set(cacheKey, {
            serverUrl,
            apiKeyPresent,
            promise: fetchPromise,
        });
        return fetchPromise;
    }

    private async getModelSources(): Promise<ChatModelSource[]> {
        const cfg = this.getConfig();
        const configuredServerUrl = await this.getServerUrl();
        const apiKey = await this.getApiKey();
        const deepSeekApiKey = await this.getDeepSeekApiKey();
        return createModelSources({
            primaryServerUrl: configuredServerUrl,
            primaryApiKey: apiKey,
            deepSeekApiKey,
            localEnabled: cfg.get<boolean>("enableLocalServer", true) !== false,
            localServerUrl: this.getConfiguredLocalServerUrl(),
            localContextLength: this.getConfiguredLocalContextLength(),
            deepSeekEnabled: cfg.get<boolean>("enableDeepSeek", true) !== false,
        });
    }

    private async resolveSourceForModel(model: LanguageModelChatInformation): Promise<{
        source: ChatModelSource;
        modelId: string;
    }> {
        const parsed = parseProviderModelId(model.id);
        const sources = await this.getModelSources();
        const source = parsed.sourceKey
            ? sources.find(candidate => candidate.key === parsed.sourceKey)
            : undefined;

        if (source) {
            return { source, modelId: parsed.modelId };
        }

        const legacyServerUrl = await this.getServerUrl();
        return {
            source: {
                key: this.isDeepSeekServer(legacyServerUrl) ? "deepseek" : "primary",
                label: this.isDeepSeekServer(legacyServerUrl) ? "DeepSeek" : "Primary",
                serverUrl: legacyServerUrl,
                apiKey: this.isDeepSeekServer(legacyServerUrl)
                    ? await this.getDeepSeekApiKey()
                    : await this.getApiKey(),
                familyOverride: this.isDeepSeekServer(legacyServerUrl) ? "deepseek" : undefined,
                contextLengthOverride: this.isDeepSeekServer(legacyServerUrl)
                    ? DEEPSEEK_CONTEXT_LENGTH
                    : undefined,
            },
            modelId: parsed.modelId,
        };
    }

    private mapModelInfo(
        model: LlamaCppModelInfo,
        source: ChatModelSource,
        runtimeContextLength?: number
    ): LanguageModelChatInformation {
        const contextLength = this.resolveModelContextLength(model, runtimeContextLength, source);
        const family = this.resolveModelFamily(model.id, source.familyOverride);
        const configuredOutputCap = this.getConfiguredMaxOutputTokens();
        const maxOutputTokens = this.resolveAdvertisedMaxOutputTokens(
            family,
            contextLength,
            configuredOutputCap
        );
        const maxInputTokens = Math.max(1, contextLength - maxOutputTokens);
        const maxTools = this.clampInt(this.getConfig().get("maxToolsPerRequest", 128), 0, 128, 128);

        // Detect vision (image input) support.
        // DeepSeek API does NOT support image input (both OpenAI-compatible and Anthropic endpoints
        // reject image_url / image content blocks). For other providers check model metadata.
        const archMeta = model.meta as Record<string, unknown> | undefined;
        const inputModalities = (archMeta?.architecture as Record<string, unknown> | undefined)
            ?.input_modalities as string[] | undefined;
        const metaModalities = archMeta?.modalities as Record<string, unknown> | undefined;
        const metaCapabilities = Array.isArray(archMeta?.capabilities)
            ? archMeta.capabilities.filter((value): value is string => typeof value === "string")
            : [];
        const capabilities = [...(model.capabilities ?? []), ...metaCapabilities]
            .map(value => value.toLowerCase());
        const imageInput =
            family !== "deepseek" &&
            (
                model.modalities?.vision === true ||
                metaModalities?.vision === true ||
                (Array.isArray(inputModalities) && inputModalities.includes("image")) ||
                capabilities.includes("vision") ||
                capabilities.includes("multimodal")
            );

        const info: LanguageModelChatInformation & Record<string, unknown> = {
            id: encodeProviderModelId(source.key, model.id),
            name: `${model.id} (${source.label})`,
            tooltip: `Model: ${model.id}\nSource: ${source.label}\nServer: ${source.serverUrl}\nContext: ${contextLength} tokens`,
            detail: `${source.label} / ${family} / ctx ${contextLength}`,
            family,
            version: "1.0.0",
            maxInputTokens,
            maxOutputTokens,
            capabilities: {
                toolCalling: maxTools > 0,
                imageInput,
            },
        };

        // Some model pickers (for example Copilot's BYOK picker pipeline) check these non-typed flags.
        info.isUserSelectable = true;
        info.multiplierNumeric = 0;
        info.model_picker_enabled = true;
        info.configurationSchema = createReasoningConfigurationSchema(family);

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
        const sources = await this.getModelSources();
        const modelListCacheTtlMs = this.getModelListCacheTtlMs();
        const allEntries: LanguageModelChatInformation[] = [];

        await Promise.all(sources.map(async source => {
            const apiKeyPresent = Boolean(source.apiKey);
            const runtimeContextLength = await this.getRuntimeContextLengthWithCache(
                source.serverUrl,
                source.apiKey,
                apiKeyPresent,
                modelListCacheTtlMs
            );

            const cachedModels = this.getFreshCachedModels(source.serverUrl, apiKeyPresent, modelListCacheTtlMs);
            if (cachedModels) {
                const entries = cachedModels.map(model => this.mapModelInfo(model, source, runtimeContextLength));
                allEntries.push(...entries);
                this.log("models.request.cache_hit", {
                    source: source.key,
                    serverUrl: source.serverUrl,
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
                return;
            }

            this.log("models.request.start", {
                source: source.key,
                serverUrl: source.serverUrl,
                hasApiKey: apiKeyPresent,
                silent: options.silent,
                cancelled: token.isCancellationRequested,
                modelListCacheTtlMs,
            });

            try {
                const models = await this.fetchModelsWithInflightCache(source.serverUrl, source.apiKey, apiKeyPresent);
                this.cacheModels(source.serverUrl, apiKeyPresent, models);
                const entries = models.map(model => this.mapModelInfo(model, source, runtimeContextLength));
                allEntries.push(...entries);
                this.log("models.request.success", {
                    source: source.key,
                    serverUrl: source.serverUrl,
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
            } catch (err) {
                this.logError("models.request.failed", err, {
                    source: source.key,
                    serverUrl: source.serverUrl,
                    silent: options.silent,
                });
                const staleModels = this.getAnyCachedModels(source.serverUrl, apiKeyPresent);
                if (staleModels) {
                    const entries = staleModels.map(model => this.mapModelInfo(model, source, runtimeContextLength));
                    allEntries.push(...entries);
                    this.log("models.request.stale_cache_fallback", {
                        source: source.key,
                        serverUrl: source.serverUrl,
                        count: entries.length,
                    });
                    return;
                }
                if (!options.silent) {
                    console.error(`[Llama.cpp Provider] Failed to fetch models from ${source.label}`, err);
                }
            }
        }));

        return allEntries.sort((a, b) => a.name.localeCompare(b.name));
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
        const { source, modelId: requestModelId } = await this.resolveSourceForModel(model);
        const serverUrl = source.serverUrl;
        const apiKey = source.apiKey;
        const apiKeyPresent = Boolean(apiKey);
        const cfg = this.getConfig();
        const requestId = randomUUID();
        const turnStartedAt = Date.now();
        const resolvedFamily = this.resolveModelFamily(requestModelId, source.familyOverride);

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
        const contextLength = this.resolveRuntimeContextLengthForRequest(model, runtimeContextLength, source);
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
        const toolCallOnlyAutoretry = cfg.get<boolean>("toolCallOnlyAutoretry", true) !== false;
        const toolCallOnlyAutoretryThreshold = this.clampInt(
            cfg.get("toolCallOnlyAutoretryThreshold", 3),
            2,
            10,
            3
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
        const thinkingMode = resolveRequestThinkingMode(
            cfg.get("thinkingMode", "auto"),
            options.modelOptions
        );
        const configuredReasoningBudget = this.clampInt(
            cfg.get("reasoningBudget", DEFAULT_LOCAL_REASONING_BUDGET),
            256,
            65536,
            DEFAULT_LOCAL_REASONING_BUDGET
        );
        const reasoningBudget = resolveReasoningBudget(thinkingMode, configuredReasoningBudget);
        const toolResultModeConfig = this.normalizeToolResultMode(cfg.get("toolResultMode", "auto"));
        const toolCallingModeConfig = this.normalizeToolCallingMode(cfg.get("toolCallingMode", "apiDirect"));
        const apiDirectMaxTools = this.clampInt(cfg.get("apiDirectMaxTools", 48), 1, 128, 48);
        const apiDirectIncludeAllTools = cfg.get<boolean>("apiDirectIncludeAllTools", false) === true;
        const apiDirectToolTokenBudget = this.clampInt(cfg.get("apiDirectToolTokenBudget", 12000), 256, 65536, 12000);
        const sharedMemoryEnabled = cfg.get<boolean>("memoryEnabled", true) !== false;
        const sharedMemoryAutoInject = cfg.get<boolean>("memoryAutoInject", true) !== false;
        const sharedMemoryMaxTokens = this.clampInt(cfg.get("memoryMaxTokens", 4096), 128, 32768, 4096);

        this.log("chat.turn.start", {
            requestId,
            modelId: requestModelId,
            providerModelId: model.id,
            source: source.key,
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
                toolCallOnlyAutoretry,
                toolCallOnlyAutoretryThreshold,
                emptyResponseContinuationPrompt,
                thinkingMode,
                configuredReasoningBudget,
                reasoningBudget,
                toolResultModeConfig,
                toolCallingModeConfig,
                apiDirectMaxTools,
                apiDirectIncludeAllTools,
                apiDirectToolTokenBudget,
                sharedMemoryEnabled,
                sharedMemoryAutoInject,
                sharedMemoryMaxTokens,
            },
        });
        // Save any user-attached images to temp files so the model can inspect them
        // via the view_image tool (DeepSeek API doesn't support inline image_url).
        const imageInputSupported = model.capabilities?.imageInput === true;
        const processedMessages = imageInputSupported
            ? messages
            : this.saveUserImagesToTemp(messages, requestId);

        validateRequest(processedMessages);
        const toolConfig = convertTools(options, {
            mode: toolCallingModeConfig as ToolCallingMode,
            apiDirectMaxTools,
            apiDirectIncludeAllTools,
            apiDirectToolTokenBudget,
        });

        let sharedMemoryContext: SharedMemoryPromptContext | undefined;
        if (sharedMemoryEnabled && sharedMemoryAutoInject && this.sharedMemory) {
            const queryMessages = convertMessages(processedMessages, {
                toolResultMode: "user",
                supportsImageInput: imageInputSupported,
            });
            try {
                sharedMemoryContext = await this.sharedMemory.buildPromptContext(
                    buildMemoryQuery(queryMessages),
                    sharedMemoryMaxTokens
                );
                this.log("chat.memory.context", {
                    requestId,
                    enabled: true,
                    entryCount: sharedMemoryContext?.entryCount ?? 0,
                    entryIds: sharedMemoryContext?.entryIds ?? [],
                    estimatedTokens: sharedMemoryContext?.estimatedTokens ?? 0,
                });
            } catch (error) {
                this.logError("chat.memory.context_error", error, { requestId });
            }
        }

        const convertForMode = (mode: ToolResultMode): OpenAIChatMessage[] => {
            const converted = convertMessages(processedMessages, {
                toolResultMode: mode,
                supportsImageInput: imageInputSupported,
            });
            return this.truncateToolResultMessages(
                injectSharedMemoryContext(converted, sharedMemoryContext?.text),
                maxToolResultChars,
                requestId
            );
        };

        const initialToolResultMode: ToolResultMode = toolResultModeConfig === "user" ? "user" : "tool";
        let activeToolResultMode: ToolResultMode = initialToolResultMode;

        // apiDirect mode already caps tools inside convertTools via apiDirectMaxTools.
        // Classic mode applies the request-level maxToolsPerRequest cap here.
        const cappedToolConfig: ReturnType<typeof convertTools> = {
            ...toolConfig,
            tools: toolCallingModeConfig === "apiDirect"
                ? toolConfig.tools
                : Array.isArray(toolConfig.tools) && maxTools > 0
                    ? toolConfig.tools.slice(0, maxTools)
                    : toolConfig.tools,
        };

        if (
            Array.isArray(toolConfig.tools) &&
            toolCallingModeConfig !== "apiDirect" &&
            toolConfig.tools.length > maxTools
        ) {
            console.warn(`[Llama.cpp Provider] Truncating tools from ${toolConfig.tools.length} to ${maxTools}`);
            this.log("chat.tools.truncated", {
                requestId,
                originalTools: toolConfig.tools.length,
                allowedTools: maxTools,
            });
        }

        const outputBudget = resolveOutputTokenBudget({
            family: resolvedFamily,
            requestedMaxTokens: typeof options.modelOptions?.max_tokens === "number"
                ? options.modelOptions.max_tokens
                : undefined,
            modelMaxOutputTokens: model.maxOutputTokens,
            hardCap: maxOutputCap,
            localDefault: this.clampInt(cfg.get("localDefaultMaxOutputTokens", 32768), 1024, 131072, 32768),
            deepSeekDefault: this.clampInt(cfg.get("deepSeekDefaultMaxOutputTokens", 65536), 1024, 393216, 65536),
            deepSeekMaximum: DEEPSEEK_MAX_OUTPUT_TOKENS,
        });
        const { defaultMaxTokens: defaultMaxOutputTokens, requestedMaxTokens, maxTokens } = outputBudget;
        const temperatureDefault = resolvedFamily === "deepseek" ? 1.0 : 0.7;
        const temperature = this.clampNumber(options.modelOptions?.temperature ?? temperatureDefault, 0, 2, temperatureDefault);
        const toolTokenCount = this.estimateToolTokens(cappedToolConfig.tools);
        const contextBudget = calculateContextBudget({
            contextLength,
            contextUtilization: contextUtil,
            hardContextUtilization: hardContextUtil,
            maxOutputTokens: maxTokens,
            minReplyReserveTokens: minReplyReserve,
            toolTokens: toolTokenCount,
        });
        const {
            modelInputLimit,
            inputBudget,
            replyReserveTokens: replyReserve,
            softInputTarget,
            hardInputTarget,
        } = contextBudget;

        this.log("chat.turn.budget", {
            requestId,
            modelInputLimit,
            inputBudget,
            toolTokenCount,
            replyReserve,
            softInputTarget,
            maxTokens,
            requestedMaxTokens,
            defaultMaxOutputTokens,
            requestProvidedOutputLimit: outputBudget.requestProvidedLimit,
            cappedTools: Array.isArray(cappedToolConfig.tools) ? cappedToolConfig.tools.length : 0,
        });

        const prepareMessagesForBudget = (sourceMessages: OpenAIChatMessage[]): PreparedMessagesForBudget => {
            let preparedMessages = sourceMessages;
            let messageTokenCount = this.estimateOpenAiMessageTokens(preparedMessages);
            const initialMessageCount = preparedMessages.length;
            const initialTokenEstimate = messageTokenCount;
            let autoCompacted = false;
            let hardCompacted = false;
            const hardTarget = hardInputTarget;

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

        const requestBody = buildChatCompletionRequest({
            model: requestModelId,
            family: resolvedFamily,
            maxTokens,
            temperature,
            cachePrompt,
            thinkingMode,
            reasoningBudget,
            topP: typeof options.modelOptions?.top_p === "number"
                ? this.clampNumber(options.modelOptions.top_p, 0, 1, 1)
                : undefined,
            topK: typeof options.modelOptions?.top_k === "number"
                ? this.clampInt(options.modelOptions.top_k, 0, 1000, 40)
                : undefined,
            tools: cappedToolConfig.tools,
            toolChoice: cappedToolConfig.tool_choice,
        });

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
            const {
                estimatedUsedTokens,
                estimatedFreeTokens,
                estimatedUsagePercent,
            } = estimateContextUsage(
                modelInputLimit,
                prepared.finalTokenEstimate,
                toolTokenCount,
                replyReserve
            );

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
                endpoint: this.getChatCompletionsEndpoint(serverUrl),
                timeoutMs: requestTimeoutMs,
                toolResultMode: activeToolResultMode,
                headers: this.redactHeaders(headers),
                requestBody: this.summarizeRequestBodyForLog(requestBody),
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
                    const hardTarget = hardInputTarget;
                    const overflowMessages = this.compactOpenAiMessages(
                        prepared.messages,
                        hardTarget,
                        hardKeepLastTurns,
                        "Conversation summary (overflow retry)"
                    );
                    requestBody.messages = overflowMessages;

                    const overflowMessageTokens = this.estimateOpenAiMessageTokens(overflowMessages);
                    const {
                        estimatedUsedTokens: overflowEstimatedUsedTokens,
                        estimatedFreeTokens: overflowEstimatedFreeTokens,
                        estimatedUsagePercent: overflowEstimatedUsagePercent,
                    } = estimateContextUsage(
                        modelInputLimit,
                        overflowMessageTokens,
                        toolTokenCount,
                        replyReserve
                    );

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
                        requestBody: this.summarizeRequestBodyForLog(requestBody),
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
            let consecutiveToolCallOnlyTurns = 0;
            let sourceMessages = convertForMode(activeToolResultMode);
            let finalAttempt: Extract<AttemptResult, { ok: true }> | undefined;
            let finalServerUsage: ChatTokenUsage | undefined;

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

                const roundServerUsage = await this.processStreamingResponse(responseBody, measuredProgress, token);
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
                    consecutiveToolCallOnlyTurns += 1;
                    const shouldNudge =
                        toolCallOnlyAutoretry &&
                        consecutiveToolCallOnlyTurns >= toolCallOnlyAutoretryThreshold &&
                        !token.isCancellationRequested;

                    this.log("chat.response.empty_output_with_tool_calls", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        toolResultMode: activeToolResultMode,
                        continuationRetryCount,
                        emittedParts,
                        emittedToolCallParts,
                        thinkingChars,
                        roundThinkingChars,
                        consecutiveToolCallOnlyTurns,
                        toolCallOnlyNudge: shouldNudge,
                    });

                    if (shouldNudge) {
                        consecutiveToolCallOnlyTurns = 0;
                        this.log("chat.response.tool_call_only_nudge", {
                            requestId,
                            attemptNo: attempt.attemptNo,
                            toolResultMode: activeToolResultMode,
                            emittedParts,
                            emittedToolCallParts,
                        });
                        sourceMessages = [
                            ...sourceMessages,
                            {
                                role: "user",
                                content:
                                    "You have been making tool calls without any text response for several turns. " +
                                    "Please pause, summarize what you have accomplished so far, and state your next plan clearly before making more tool calls.",
                            },
                        ];
                        continue;
                    }
                } else {
                    // Text was produced; reset the tool-call-only counter.
                    consecutiveToolCallOnlyTurns = 0;
                }

                finalAttempt = attempt;
                finalServerUsage = roundServerUsage;
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
            const estimatedPromptTokens = (latestContextUsage?.messageTokensAfterCompact ?? 0) +
                (latestContextUsage?.toolTokens ?? 0);
            const reportedUsage = finalServerUsage ?? estimateChatTokenUsage(
                estimatedPromptTokens,
                outputChars + thinkingChars
            );
            const usageSource = finalServerUsage ? "server" : "estimate";
            const promptCacheUsage = calculatePromptCacheUsage(reportedUsage);

            progress.report(vscode.LanguageModelDataPart.text(JSON.stringify(reportedUsage), "usage"));
            this.log("chat.response.usage", {
                requestId,
                attemptNo: finalAttempt.attemptNo,
                source: usageSource,
                usage: reportedUsage,
                promptCache: promptCacheUsage,
            });

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
                promptTokens: reportedUsage.prompt_tokens,
                cachedPromptTokens: promptCacheUsage?.cachedTokens,
                promptCacheHitPercent: promptCacheUsage?.hitPercent,
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

    private async getDeepSeekApiKey(): Promise<string | undefined> {
        return (await this.secrets.get("llamacpp.deepSeekApiKey")) ?? (await this.getApiKey());
    }

    /**
     * Fetches the list of available models from the Llama.cpp server.
      * Makes a GET request to the provider model-list endpoint.
     *
     * @param serverUrl - The base URL of the Llama.cpp server.
     * @param apiKey - Optional API key for authentication.
     * @returns Promise resolving to an array of model objects.
     */
    private async fetchModels(serverUrl: string, apiKey?: string): Promise<LlamaCppModelInfo[]> {
        const headers: Record<string, string> = {
              "User-Agent": this.userAgent,
              "Accept": "application/json",
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const endpoint = this.getModelsEndpoint(serverUrl);

        this.log("models.http.send", {
            endpoint,
            headers: this.redactHeaders(headers),
        });

        const response = await this.fetchWithTimeout(
            endpoint,
            {
                method: "GET",
                headers,
            },
            this.getModelDiscoveryTimeoutMs()
        );

        this.log("models.http.response", {
            status: response.status,
            statusText: response.statusText,
        });

        if (!response.ok) {
            let bodySnippet = "";
            try {
                const bodyText = await response.text();
                bodySnippet = bodyText.trim().slice(0, 300);
            } catch {
                bodySnippet = "";
            }
            const details = bodySnippet ? `\n${bodySnippet}` : "";
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}${details}`);
        }

        const data = (await response.json()) as { data?: unknown[]; models?: unknown[] };
        const descriptors = Array.isArray(data.models)
            ? data.models.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            : [];
        const serverModalities = await this.fetchServerModalities(serverUrl, headers);
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

            const normalizedId = id.trim();
            const descriptor = descriptors.find(candidate => {
                const candidateId =
                    typeof candidate.id === "string"
                        ? candidate.id
                        : typeof candidate.model === "string"
                          ? candidate.model
                          : typeof candidate.name === "string"
                            ? candidate.name
                            : undefined;
                return candidateId?.trim() === normalizedId;
            });

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
                    contextLength = this.clampInt(parsed, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
                    break;
                }
            }

            const meta = modelMeta as LlamaCppModelInfo["meta"] | undefined;

            const rawCapabilities = Array.isArray(obj.capabilities)
                ? obj.capabilities
                : Array.isArray(descriptor?.capabilities)
                  ? descriptor.capabilities
                  : [];
            const capabilities = rawCapabilities.filter((value): value is string => typeof value === "string");
            const rawModalities =
                obj.modalities && typeof obj.modalities === "object"
                    ? obj.modalities as Record<string, unknown>
                    : descriptor?.modalities && typeof descriptor.modalities === "object"
                      ? descriptor.modalities as Record<string, unknown>
                      : undefined;
            const modalities = {
                vision: rawModalities?.vision === true || serverModalities?.vision === true,
                audio: rawModalities?.audio === true || serverModalities?.audio === true,
            };

            return [{ id: normalizedId, aliases, contextLength, capabilities, modalities, meta }];
        });
    }

    private async fetchServerModalities(
        serverUrl: string,
        headers: Record<string, string>
    ): Promise<LlamaCppModelInfo["modalities"] | undefined> {
        if (this.isDeepSeekServer(serverUrl)) {
            return undefined;
        }

        const endpoint = `${serverUrl}/props`;
        try {
            const response = await this.fetchWithTimeout(
                endpoint,
                { method: "GET", headers },
                this.getModelDiscoveryTimeoutMs()
            );
            if (!response.ok) {
                this.log("models.modalities.props_unavailable", {
                    endpoint,
                    status: response.status,
                    statusText: response.statusText,
                });
                return undefined;
            }

            const body = await response.json() as Record<string, unknown>;
            const rawModalities = body.modalities;
            if (!rawModalities || typeof rawModalities !== "object") {
                return undefined;
            }

            const modalities = rawModalities as Record<string, unknown>;
            const result = {
                vision: modalities.vision === true,
                audio: modalities.audio === true,
            };
            this.log("models.modalities.detected", { endpoint, ...result });
            return result;
        } catch (error) {
            this.logError("models.modalities.props_failed", error, { endpoint });
            return undefined;
        }
    }

    private shouldProbeRuntimeSlots(serverUrl: string): boolean {
        return !this.isDeepSeekServer(serverUrl);
    }

    private async fetchWithTimeout(
        url: string,
        init: RequestInit,
        timeoutMs: number
    ): Promise<Response> {
        return this.httpTransport.request(url, init, timeoutMs);
    }
}
