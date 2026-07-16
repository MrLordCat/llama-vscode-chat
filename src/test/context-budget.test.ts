import * as assert from "assert";
import { calculateContextBudget, estimateContextUsage } from "../context/context-budget";

suite("context budget", () => {
	test("reserves output and tool tokens from soft and hard targets", () => {
		const budget = calculateContextBudget({
			contextLength: 131072,
			contextUtilization: 0.85,
			hardContextUtilization: 0.72,
			maxOutputTokens: 8192,
			minReplyReserveTokens: 1536,
			toolTokens: 2048,
		});

		assert.strictEqual(budget.modelInputLimit, 131072);
		assert.strictEqual(budget.inputBudget, 111411);
		assert.strictEqual(budget.replyReserveTokens, 8192);
		assert.strictEqual(budget.softInputTarget, 101171);
		assert.strictEqual(budget.hardInputTarget, 84131);
	});

	test("uses the configured minimum reply reserve", () => {
		const budget = calculateContextBudget({
			contextLength: 49152,
			contextUtilization: 0.85,
			hardContextUtilization: 0.72,
			maxOutputTokens: 512,
			minReplyReserveTokens: 1536,
			toolTokens: 0,
		});

		assert.strictEqual(budget.replyReserveTokens, 1536);
	});

	test("reports usage against the runtime context window", () => {
		assert.deepStrictEqual(estimateContextUsage(49152, 20000, 2000, 8000), {
			estimatedUsedTokens: 30000,
			estimatedFreeTokens: 19152,
			estimatedUsagePercent: 61,
		});
	});

	test("allows usage above 100 percent while clamping free tokens", () => {
		assert.deepStrictEqual(estimateContextUsage(4096, 5000, 1000, 1000), {
			estimatedUsedTokens: 7000,
			estimatedFreeTokens: 0,
			estimatedUsagePercent: 170.9,
		});
	});
});
