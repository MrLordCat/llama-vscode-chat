import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelResponsePart,
    Progress,
} from "vscode";
import { convertMessages, convertTools, validateRequest } from "./utils";
import { BaseChatModelProvider, DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_OUTPUT_TOKENS } from "./base-provider";

const BASE_URL = "https://router.huggingface.co/v1";

type HuggingFaceProviderInfo = {
    provider: string;
    supports_tools?: boolean;
    context_length?: number;
};

type HuggingFaceModelInfo = {
    id: string;
    providers?: HuggingFaceProviderInfo[];
    architecture?: {
        input_modalities?: string[];
    };
};

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider extends BaseChatModelProvider {
    constructor(secrets: vscode.SecretStorage, private readonly userAgent: string) {
        super(secrets);
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const apiKey = await this.ensureApiKey(options.silent);
        if (!apiKey) {
            return [];
        }

        try {
            const { models } = await this.fetchModels(apiKey);
            const infos = models.flatMap(model => {
                const providers = model.providers ?? [];
                const modalities = model.architecture?.input_modalities ?? [];
                const vision = Array.isArray(modalities) && modalities.includes("image");

                const toolProviders = providers.filter(p => p.supports_tools === true);
                const entries: LanguageModelChatInformation[] = [];

                if (toolProviders.length > 0) {
                    const contextLengths = toolProviders
                        .map(p => (typeof p.context_length === "number" && p.context_length > 0 ? p.context_length : undefined))
                        .filter((len): len is number => typeof len === "number");

                    const aggregateContextLen =
                        contextLengths.length > 0 ? Math.min(...contextLengths) : DEFAULT_CONTEXT_LENGTH;
                    const maxOutput = DEFAULT_MAX_OUTPUT_TOKENS;
                    const maxInput = Math.max(1, aggregateContextLen - maxOutput);

                    entries.push({
                        id: `${model.id}:cheapest`,
                        name: `${model.id} (cheapest)`,
                        tooltip: "Hugging Face via the cheapest provider",
                        family: "huggingface",
                        version: "1.0.0",
                        maxInputTokens: maxInput,
                        maxOutputTokens: maxOutput,
                        capabilities: {
                            toolCalling: true,
                            imageInput: vision,
                        },
                    });

                    entries.push({
                        id: `${model.id}:fastest`,
                        name: `${model.id} (fastest)`,
                        tooltip: "Hugging Face via the fastest provider",
                        family: "huggingface",
                        version: "1.0.0",
                        maxInputTokens: maxInput,
                        maxOutputTokens: maxOutput,
                        capabilities: {
                            toolCalling: true,
                            imageInput: vision,
                        },
                    });
                }

                for (const provider of toolProviders) {
                    const contextLen = provider.context_length ?? DEFAULT_CONTEXT_LENGTH;
                    const maxOutput = DEFAULT_MAX_OUTPUT_TOKENS;
                    const maxInput = Math.max(1, contextLen - maxOutput);

                    entries.push({
                        id: `${model.id}:${provider.provider}`,
                        name: `${model.id} via ${provider.provider}`,
                        tooltip: `Hugging Face via ${provider.provider}`,
                        family: "huggingface",
                        version: "1.0.0",
                        maxInputTokens: maxInput,
                        maxOutputTokens: maxOutput,
                        capabilities: {
                            toolCalling: true,
                            imageInput: vision,
                        },
                    });
                }

                if (toolProviders.length === 0 && providers.length > 0) {
                    const base = providers[0];
                    const contextLen = base.context_length ?? DEFAULT_CONTEXT_LENGTH;
                    const maxOutput = DEFAULT_MAX_OUTPUT_TOKENS;
                    const maxInput = Math.max(1, contextLen - maxOutput);

                    entries.push({
                        id: model.id,
                        name: model.id,
                        tooltip: "Hugging Face",
                        family: "huggingface",
                        version: "1.0.0",
                        maxInputTokens: maxInput,
                        maxOutputTokens: maxOutput,
                        capabilities: {
                            toolCalling: false,
                            imageInput: vision,
                        },
                    });
                }

                return entries;
            });

            return infos;
        } catch (err) {
            console.error("[Hugging Face Model Provider] Error parsing models", err);
            return [];
        }
    }

    /**
     * Fetch the list of models and supplementary metadata from Hugging Face.
     */
    private async fetchModels(apiKey: string): Promise<{ models: HuggingFaceModelInfo[] }> {
        const response = await fetch(`${BASE_URL}/models`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "User-Agent": this.userAgent,
            },
        });

        if (!response.ok) {
            let text = "";
            try {
                text = await response.text();
            } catch (error) {
                console.error("[Hugging Face Model Provider] Failed to read response text", error);
            }

            const err = new Error(
                `Failed to fetch Hugging Face models: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`
            );
            console.error("[Hugging Face Model Provider] Failed to fetch Hugging Face models", err);
            throw err;
        }

        const parsed = (await response.json()) as { data?: HuggingFaceModelInfo[] };
        return { models: parsed.data ?? [] };
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        try {
            const apiKey = await this.ensureApiKey(true);
            if (!apiKey) {
                throw new Error("Hugging Face API key not found");
            }

            const openaiMessages = convertMessages(messages);
            validateRequest(messages);
            const toolConfig = convertTools(options);

            if (options.tools && options.tools.length > 128) {
                throw new Error("Cannot have more than 128 tools per request.");
            }

            const inputTokenCount = this.estimateMessagesTokens(messages);
            const toolTokenCount = this.estimateToolTokens(toolConfig.tools);
            const tokenLimit = Math.max(1, model.maxInputTokens);
            if (inputTokenCount + toolTokenCount > tokenLimit) {
                console.error("[Hugging Face Model Provider] Message exceeds token limit", {
                    total: inputTokenCount + toolTokenCount,
                    tokenLimit,
                });
                throw new Error("Message exceeds token limit.");
            }

            const requestBody: Record<string, unknown> = {
                model: model.id,
                messages: openaiMessages,
                stream: true,
                max_tokens: Math.min(options.modelOptions?.max_tokens || 4096, model.maxOutputTokens),
                temperature: options.modelOptions?.temperature ?? 0.7,
            };

            if (options.modelOptions) {
                const mo = options.modelOptions;
                if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
                    requestBody.stop = mo.stop;
                }
                if (typeof mo.frequency_penalty === "number") {
                    requestBody.frequency_penalty = mo.frequency_penalty;
                }
                if (typeof mo.presence_penalty === "number") {
                    requestBody.presence_penalty = mo.presence_penalty;
                }
            }

            if (toolConfig.tools) {
                requestBody.tools = toolConfig.tools;
            }
            if (toolConfig.tool_choice) {
                requestBody.tool_choice = toolConfig.tool_choice;
            }

            const response = await fetch(`${BASE_URL}/chat/completions`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "User-Agent": this.userAgent,
                },
                body: JSON.stringify(requestBody),
                signal: token.isCancellationRequested ? AbortSignal.abort() : undefined,
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("[Hugging Face Model Provider] HF API error response", errorText);
                throw new Error(`Hugging Face API error: ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`);
            }

            if (!response.body) {
                throw new Error("No response body from Hugging Face API");
            }

            await this.processStreamingResponse(response.body, progress, token);
        } catch (err) {
            console.error("[Hugging Face Model Provider] Chat request failed", {
                modelId: model.id,
                messageCount: messages.length,
                error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
            });
            throw err;
        }
    }

    /**
     * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
     */
    private async ensureApiKey(silent: boolean): Promise<string | undefined> {
        let apiKey = await this.secrets.get("huggingface.apiKey");
        if (!apiKey && !silent) {
            const entered = await vscode.window.showInputBox({
                title: "Hugging Face API Key",
                prompt: "Enter your Hugging Face API key",
                ignoreFocusOut: true,
                password: true,
            });
            if (entered && entered.trim()) {
                apiKey = entered.trim();
                await this.secrets.store("huggingface.apiKey", apiKey);
            }
        }
        return apiKey;
    }
}
