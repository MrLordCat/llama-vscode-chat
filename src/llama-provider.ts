
import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelResponsePart,
    Progress,
} from "vscode";
import { BaseChatModelProvider, DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_OUTPUT_TOKENS } from "./base-provider";
import { convertMessages, convertTools, validateRequest, type ToolResultMode } from "./utils";
import type { OpenAIChatMessage } from "./types";

type ThinkingMode = "off" | "light" | "balanced" | "deep" | "auto";
type ToolResultModeConfig = "auto" | "tool" | "user";

/**
 * Chat model provider for Llama.cpp servers.
 * Implements the VS Code language model chat provider interface for Llama.cpp compatible APIs.
 * Handles model discovery, chat responses, and streaming from local Llama.cpp instances.
 *
 */
export class LlamaCppChatModelProvider extends BaseChatModelProvider {
    /**
     * Creates a new Llama.cpp chat model provider.
     * Initializes the provider with secret storage and user agent for API requests.
     *
     * @param secrets - VS Code secret storage for storing server URL and API key.
     * @param userAgent - User agent string to include in HTTP requests.
     */
    constructor(secrets: vscode.SecretStorage, private readonly userAgent: string) {
        super(secrets);
    }

    private getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration("llamacpp");
    }

    private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
        const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
        return Math.min(max, Math.max(min, n));
    }

    private clampInt(value: unknown, min: number, max: number, fallback: number): number {
        const n = Number.isInteger(value) ? (value as number) : fallback;
        return Math.min(max, Math.max(min, n));
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

        const keepLast = Math.min(nonSystem.length, Math.max(2, keepLastCount));
        const head = nonSystem.slice(0, Math.max(0, nonSystem.length - keepLast));
        let tail = nonSystem.slice(Math.max(0, nonSystem.length - keepLast));

        const summaryLines: string[] = [];
        for (const msg of head.slice(-24)) {
            const text = this.contentToText(msg.content).replace(/\s+/g, " ").trim();
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

        try {
            const models = await this.fetchModels(serverUrl, apiKey);
            return models.map(model => ({
                id: model.id,
                name: model.id, // Llama.cpp usually returns filename as ID
                tooltip: `Llama.cpp model: ${model.id}`,
                family: "llama-cpp",
                version: "1.0.0",
                maxInputTokens: DEFAULT_CONTEXT_LENGTH - DEFAULT_MAX_OUTPUT_TOKENS, // Rough estimate or configurable
                maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
                capabilities: {
                    toolCalling: true, // Assuming modern models support it
                    imageInput: false, // Could be true for vision models, but safe default is false
                },
            }));
        } catch (err) {
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
        const cfg = this.getConfig();

        const contextUtil = this.clampNumber(cfg.get("contextUtilization", 0.85), 0.5, 0.95, 0.85);
        const hardContextUtil = this.clampNumber(cfg.get("hardContextUtilization", 0.72), 0.4, 0.9, 0.72);
        const keepLastTurns = this.clampInt(cfg.get("compactKeepLastTurns", 12), 2, 64, 12);
        const hardKeepLastTurns = this.clampInt(cfg.get("hardCompactKeepLastTurns", 6), 1, 32, 6);
        const maxOutputCap = this.clampInt(cfg.get("maxOutputTokensCap", 4096), 128, 32768, 4096);
        const minReplyReserve = this.clampInt(cfg.get("minReplyReserveTokens", 1536), 256, 32768, 1536);
        const maxTools = this.clampInt(cfg.get("maxToolsPerRequest", 128), 0, 128, 128);
        const requestTimeoutMs = this.clampInt(cfg.get("requestTimeoutMs", 240000), 10000, 1200000, 240000);
        const autoCompact = cfg.get<boolean>("autoCompact", true) !== false;
        const retryOnOverflow = cfg.get<boolean>("retryOnContextOverflow", true) !== false;
        const thinkingMode = this.normalizeThinkingMode(cfg.get("thinkingMode", "auto"));
        const configuredReasoningBudget = this.clampInt(cfg.get("reasoningBudget", 2048), 0, 65536, 2048);
        const reasoningBudget = this.resolveReasoningBudget(thinkingMode, configuredReasoningBudget);
        const toolResultModeConfig = this.normalizeToolResultMode(cfg.get("toolResultMode", "auto"));

        validateRequest(messages);
        const toolConfig = convertTools(options);
        const convertForMode = (mode: ToolResultMode): OpenAIChatMessage[] =>
            convertMessages(messages, { toolResultMode: mode });

        const initialToolResultMode: ToolResultMode = toolResultModeConfig === "user" ? "user" : "tool";
        let activeToolResultMode: ToolResultMode = initialToolResultMode;

        const cappedToolConfig: ReturnType<typeof convertTools> = {
            ...toolConfig,
            tools: Array.isArray(toolConfig.tools) ? (maxTools > 0 ? toolConfig.tools.slice(0, maxTools) : []) : undefined,
        };

        if (Array.isArray(toolConfig.tools) && toolConfig.tools.length > maxTools) {
            console.warn(`[Llama.cpp Provider] Truncating tools from ${toolConfig.tools.length} to ${maxTools}`);
        }

        const requestedMaxTokens = this.clampInt(options.modelOptions?.max_tokens, 1, 262144, 4096);
        const maxTokens = Math.max(1, Math.min(requestedMaxTokens, model.maxOutputTokens, maxOutputCap));
        const temperature = this.clampNumber(options.modelOptions?.temperature ?? 0.7, 0, 2, 0.7);

        const modelInputLimit = Math.max(1, model.maxInputTokens);
        const inputBudget = Math.max(1, Math.floor(modelInputLimit * contextUtil));
        const toolTokenCount = this.estimateToolTokens(cappedToolConfig.tools);
        const replyReserve = Math.max(minReplyReserve, maxTokens);
        const softInputTarget = Math.max(1, inputBudget - replyReserve - toolTokenCount);

        const prepareMessagesForBudget = (sourceMessages: OpenAIChatMessage[]): OpenAIChatMessage[] => {
            let preparedMessages = sourceMessages;
            let messageTokenCount = this.estimateOpenAiMessageTokens(preparedMessages);

            if (autoCompact && messageTokenCount > softInputTarget) {
                preparedMessages = this.compactOpenAiMessages(
                    preparedMessages,
                    softInputTarget,
                    keepLastTurns,
                    "Conversation summary (auto-compact)"
                );
                messageTokenCount = this.estimateOpenAiMessageTokens(preparedMessages);
            }

            if (messageTokenCount > softInputTarget) {
                const hardTarget = Math.max(1, Math.floor(modelInputLimit * hardContextUtil) - replyReserve - toolTokenCount);
                preparedMessages = this.compactOpenAiMessages(
                    preparedMessages,
                    hardTarget,
                    hardKeepLastTurns,
                    "Conversation summary (hard compact)"
                );
                messageTokenCount = this.estimateOpenAiMessageTokens(preparedMessages);
                if (messageTokenCount > hardTarget) {
                    throw new Error("Conversation is still too large after compaction. Start a new chat or reduce history.");
                }
            }

            return preparedMessages;
        };

        const requestBody: Record<string, unknown> = {
            model: model.id,
            messages: [],
            stream: true,
            max_tokens: maxTokens,
            temperature,
        };

        requestBody.reasoning_budget = reasoningBudget;

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
            | { ok: true; response: Response; retriedAfterOverflow: boolean }
            | {
                  ok: false;
                  status: number;
                  statusText: string;
                  errorText: string;
                  retriedAfterOverflow: boolean;
              };

        const attemptRequest = async (sourceMessages: OpenAIChatMessage[]): Promise<AttemptResult> => {
            const preparedMessages = prepareMessagesForBudget(sourceMessages);
            requestBody.messages = preparedMessages;

            let response = await this.sendChatCompletion(serverUrl, headers, requestBody, requestTimeoutMs, token);
            let retriedAfterOverflow = false;

            if (!response.ok && retryOnOverflow) {
                const errText = await response.text();
                if (this.isContextOverflowError(response.status, errText)) {
                    const hardTarget = Math.max(
                        1,
                        Math.floor(modelInputLimit * hardContextUtil) - replyReserve - toolTokenCount
                    );
                    requestBody.messages = this.compactOpenAiMessages(
                        preparedMessages,
                        hardTarget,
                        hardKeepLastTurns,
                        "Conversation summary (overflow retry)"
                    );
                    response = await this.sendChatCompletion(serverUrl, headers, requestBody, requestTimeoutMs, token);
                    retriedAfterOverflow = true;
                } else {
                    return {
                        ok: false,
                        status: response.status,
                        statusText: response.statusText,
                        errorText: errText,
                        retriedAfterOverflow,
                    };
                }
            }

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    ok: false,
                    status: response.status,
                    statusText: response.statusText,
                    errorText,
                    retriedAfterOverflow,
                };
            }

            return { ok: true, response, retriedAfterOverflow };
        };

        try {
            let attempt = await attemptRequest(convertForMode(activeToolResultMode));

            if (
                !attempt.ok &&
                toolResultModeConfig === "auto" &&
                activeToolResultMode === "tool" &&
                this.isToolRoleCompatibilityError(attempt.status, attempt.errorText)
            ) {
                console.warn("[Llama.cpp Provider] Falling back to user-style tool results for compatibility");
                activeToolResultMode = "user";
                attempt = await attemptRequest(convertForMode(activeToolResultMode));
            }

            if (!attempt.ok) {
                const retryHint = attempt.retriedAfterOverflow
                    ? "\nRetry after automatic compaction did not fit context."
                    : "";
                throw new Error(`Llama.cpp API error: ${attempt.status} ${attempt.statusText}\n${attempt.errorText}${retryHint}`);
            }

            if (!attempt.response.body) {
                throw new Error("No response body from Llama.cpp API");
            }

            await this.processStreamingResponse(attempt.response.body, progress, token);
        } catch (err) {
            console.error("[Llama.cpp Provider] Chat request failed", err);
            throw err;
        }
    }

    /**
     * Retrieves the configured server URL from secrets.
     * Falls back to default localhost URL if not configured.
     *
     * @returns Promise resolving to the server URL.
     */
    private async getServerUrl(): Promise<string> {
        // Default to localhost:8080 if not configured
        return (await this.secrets.get("llamacpp.serverUrl")) || "http://localhost:8080";
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
    private async fetchModels(serverUrl: string, apiKey?: string): Promise<{ id: string }[]> {
        const headers: Record<string, string> = {
             "User-Agent": this.userAgent
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const response = await fetch(`${serverUrl}/v1/models`, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as { data: { id: string }[] };
        return data.data || [];
    }
}
