import * as assert from "node:assert";
import { resolveOutputTokenBudget } from "../context/output-budget";

suite("output token budget", () => {
	test("uses a normal DeepSeek default without consuming the emergency ceiling", () => {
		const budget = resolveOutputTokenBudget({
			family: "deepseek",
			modelMaxOutputTokens: 393216,
			hardCap: 393216,
			localDefault: 32768,
			deepSeekDefault: 65536,
			deepSeekMaximum: 393216,
		});

		assert.deepStrictEqual(budget, {
			defaultMaxTokens: 65536,
			requestedMaxTokens: 65536,
			maxTokens: 65536,
			requestProvidedLimit: false,
		});
	});

	test("honors an explicit request while enforcing model and global limits", () => {
		const budget = resolveOutputTokenBudget({
			family: "qwen",
			requestedMaxTokens: 50000,
			modelMaxOutputTokens: 32768,
			hardCap: 24000,
			localDefault: 16384,
			deepSeekDefault: 65536,
			deepSeekMaximum: 393216,
		});

		assert.strictEqual(budget.requestProvidedLimit, true);
		assert.strictEqual(budget.requestedMaxTokens, 50000);
		assert.strictEqual(budget.maxTokens, 24000);
	});
});
