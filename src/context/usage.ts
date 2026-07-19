export interface ChatTokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
}

export interface PromptCacheUsage {
	promptTokens: number;
	cachedTokens: number;
	uncachedTokens: number;
	hitPercent: number;
}

function toNonNegativeInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}

	return Math.max(0, Math.floor(value));
}

export function normalizeChatTokenUsage(value: unknown): ChatTokenUsage | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const promptTokens = toNonNegativeInteger(candidate.prompt_tokens);
	const completionTokens = toNonNegativeInteger(candidate.completion_tokens);
	const totalTokens = toNonNegativeInteger(candidate.total_tokens);

	if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
		return undefined;
	}

	const detailsCandidate = candidate.prompt_tokens_details;
	const openAiCachedTokens = detailsCandidate && typeof detailsCandidate === "object"
		? toNonNegativeInteger((detailsCandidate as Record<string, unknown>).cached_tokens)
		: undefined;
	const deepSeekCachedTokens = toNonNegativeInteger(candidate.prompt_cache_hit_tokens);
	const cachedTokensCandidate = openAiCachedTokens ?? deepSeekCachedTokens;
	const cachedTokens = cachedTokensCandidate === undefined
		? undefined
		: Math.min(promptTokens, cachedTokensCandidate);

	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: totalTokens,
		...(cachedTokens === undefined
			? {}
			: { prompt_tokens_details: { cached_tokens: cachedTokens } }),
	};
}

export function calculatePromptCacheUsage(usage: ChatTokenUsage): PromptCacheUsage | undefined {
	const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
	if (cachedTokens === undefined) {
		return undefined;
	}

	const promptTokens = Math.max(0, usage.prompt_tokens);
	const normalizedCachedTokens = Math.min(promptTokens, Math.max(0, cachedTokens));
	return {
		promptTokens,
		cachedTokens: normalizedCachedTokens,
		uncachedTokens: Math.max(0, promptTokens - normalizedCachedTokens),
		hitPercent: promptTokens === 0 ? 0 : Number(((normalizedCachedTokens / promptTokens) * 100).toFixed(1)),
	};
}

export function mergeChatTokenUsage(left: ChatTokenUsage, right: ChatTokenUsage): ChatTokenUsage {
	const leftCached = left.prompt_tokens_details?.cached_tokens;
	const rightCached = right.prompt_tokens_details?.cached_tokens;
	return {
		prompt_tokens: left.prompt_tokens + right.prompt_tokens,
		completion_tokens: left.completion_tokens + right.completion_tokens,
		total_tokens: left.total_tokens + right.total_tokens,
		...(leftCached !== undefined && rightCached !== undefined
			? { prompt_tokens_details: { cached_tokens: leftCached + rightCached } }
			: {}),
	};
}

export function estimateChatTokenUsage(promptTokens: number, completionCharacters: number): ChatTokenUsage {
	const normalizedPromptTokens = Math.max(0, Math.floor(promptTokens));
	const completionTokens = Math.ceil(Math.max(0, completionCharacters) / 4);

	return {
		prompt_tokens: normalizedPromptTokens,
		completion_tokens: completionTokens,
		total_tokens: normalizedPromptTokens + completionTokens,
	};
}
