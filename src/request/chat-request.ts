import { toDeepSeekReasoningEffort, type ThinkingMode } from "../reasoning";
import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../types";

export type OpenAIToolChoice = "auto" | {
	type: "function";
	function: { name: string };
};

export interface BuildChatCompletionRequestInput {
	model: string;
	family: string;
	maxTokens: number;
	temperature: number;
	cachePrompt: boolean;
	thinkingMode: ThinkingMode;
	reasoningBudget: number;
	topP?: number;
	topK?: number;
	tools?: OpenAIFunctionToolDef[];
	toolChoice?: OpenAIToolChoice;
}

export type ChatCompletionRequestBody = Record<string, unknown> & {
	model: string;
	messages: OpenAIChatMessage[];
	stream: true;
	stream_options: { include_usage: true };
	max_tokens: number;
};

export function buildChatCompletionRequest(
	input: BuildChatCompletionRequestInput
): ChatCompletionRequestBody {
	const isDeepSeek = input.family === "deepseek";
	const isDeepSeekThinkingRequest = isDeepSeek && input.thinkingMode !== "off";
	const request: ChatCompletionRequestBody = {
		model: input.model,
		messages: [],
		stream: true,
		stream_options: {
			include_usage: true,
		},
		max_tokens: input.maxTokens,
	};

	if (!isDeepSeekThinkingRequest) {
		request.temperature = input.temperature;
		if (input.topP !== undefined) {
			request.top_p = input.topP;
		}
		if (input.topK !== undefined) {
			request.top_k = input.topK;
		}
	}

	if (isDeepSeek) {
		request.thinking = {
			type: input.thinkingMode === "off" ? "disabled" : "enabled",
		};
		const reasoningEffort = toDeepSeekReasoningEffort(input.thinkingMode);
		if (reasoningEffort) {
			request.reasoning_effort = reasoningEffort;
		}
	} else {
		request.cache_prompt = input.cachePrompt;
		request.reasoning_budget = input.reasoningBudget;
		request.reasoning = {
			budget_tokens: input.reasoningBudget,
		};
	}

	if (input.tools) {
		request.tools = input.tools;
	}
	if (input.toolChoice && !isDeepSeek) {
		request.tool_choice = input.toolChoice;
	}

	return request;
}
