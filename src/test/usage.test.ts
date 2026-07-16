import * as assert from "assert";
import { estimateChatTokenUsage, normalizeChatTokenUsage } from "../context/usage";

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

	test("estimates completion usage when the server omits it", () => {
		assert.deepStrictEqual(estimateChatTokenUsage(100, 17), {
			prompt_tokens: 100,
			completion_tokens: 5,
			total_tokens: 105,
		});
	});
});
