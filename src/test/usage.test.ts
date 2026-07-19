import * as assert from "assert";
import { calculatePromptCacheUsage, estimateChatTokenUsage, mergeChatTokenUsage, normalizeChatTokenUsage } from "../context/usage";

suite("chat token usage", () => {
	test("normalizes server usage and cached prompt tokens", () => {
		assert.deepStrictEqual(normalizeChatTokenUsage({
			prompt_tokens: 14.9,
			completion_tokens: 2,
			total_tokens: 16.9,
			prompt_tokens_details: { cached_tokens: 13.8 },
		}), {
			prompt_tokens: 14,
			completion_tokens: 2,
			total_tokens: 16,
			prompt_tokens_details: { cached_tokens: 13 },
		});
	});

	test("rejects incomplete usage objects", () => {
		assert.strictEqual(normalizeChatTokenUsage({ prompt_tokens: 10 }), undefined);
		assert.strictEqual(normalizeChatTokenUsage(null), undefined);
	});

	test("normalizes DeepSeek cache counters and calculates the hit rate", () => {
		const usage = normalizeChatTokenUsage({
			prompt_tokens: 100,
			completion_tokens: 20,
			total_tokens: 120,
			prompt_cache_hit_tokens: 75,
			prompt_cache_miss_tokens: 25,
		});

		assert.deepStrictEqual(usage?.prompt_tokens_details, { cached_tokens: 75 });
		assert.deepStrictEqual(usage && calculatePromptCacheUsage(usage), {
			promptTokens: 100,
			cachedTokens: 75,
			uncachedTokens: 25,
			hitPercent: 75,
		});
	});

	test("estimates completion usage when the server omits it", () => {
		assert.deepStrictEqual(estimateChatTokenUsage(100, 17), {
			prompt_tokens: 100,
			completion_tokens: 5,
			total_tokens: 105,
		});
	});

	test("merges usage across internal model turns without inventing cache telemetry", () => {
		assert.deepStrictEqual(mergeChatTokenUsage(
			{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } },
			{ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 45 } }
		), {
			prompt_tokens: 150,
			completion_tokens: 30,
			total_tokens: 180,
			prompt_tokens_details: { cached_tokens: 125 },
		});
		assert.strictEqual(mergeChatTokenUsage(
			{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			{ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 45 } }
		).prompt_tokens_details, undefined);
	});
});
