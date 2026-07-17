import * as assert from "assert";

import { calculateOverallHealth, renderProviderHealthMarkdown } from "../diagnostics/provider-health";
import { SessionQualityTracker } from "../diagnostics/session-report";
import type { LlamaChatContextUsageMetrics, LlamaChatTurnMetrics } from "../llama-provider";

function turn(overrides: Partial<LlamaChatTurnMetrics> = {}): LlamaChatTurnMetrics {
	return {
		requestId: "request-1",
		modelId: "local::qwen",
		durationMs: 1000,
		queueWaitMs: 0,
		firstTokenLatencyMs: 100,
		emittedParts: 2,
		outputChars: 400,
		thinkingChars: 100,
		estimatedOutputTokens: 100,
		tokensPerSecond: 20,
		promptTokens: 1000,
		cachedPromptTokens: 750,
		promptCacheHitPercent: 75,
		retriedAfterOverflow: false,
		toolCalls: 2,
		repairedToolCalls: 1,
		rejectedToolCalls: 0,
		schemaRejectedToolCalls: 0,
		toolCallRepairRetries: 0,
		toolLoopDetected: false,
		...overrides,
	};
}

suite("diagnostics", () => {
	test("calculates and renders provider health", () => {
		const checks = [
			{ id: "models", label: "Models", status: "pass" as const, detail: "1 model" },
			{ id: "cache", label: "Cache", status: "warning" as const, detail: "disabled" },
		];
		assert.strictEqual(calculateOverallHealth(checks), "warning");
		const markdown = renderProviderHealthMarkdown({
			generatedAt: "2026-07-17T00:00:00.000Z",
			extensionVersion: "1.3.0",
			vscodeVersion: "1.129.0",
			overallStatus: "warning",
			configurationChecks: checks,
			sources: [{ key: "local", label: "Local", serverUrl: "http://localhost:8000", modelIds: ["qwen"], checks }],
		});
		assert.match(markdown, /Overall: WARNING/);
		assert.match(markdown, /Local/);
	});

	test("aggregates session quality without message bodies", () => {
		const tracker = new SessionQualityTracker();
		const context = {
			requestId: "request-1",
			modelId: "local::qwen",
			attemptNo: 1,
			contextLength: 131072,
			inputBudget: 100000,
			softInputTarget: 90000,
			hardInputTarget: 80000,
			messageTokensBeforeCompact: 50000,
			messageTokensAfterCompact: 40000,
			messageCountBeforeCompact: 20,
			messageCountAfterCompact: 12,
			toolTokens: 5000,
			replyReserveTokens: 8000,
			cappedTools: 48,
			autoCompacted: true,
			hardCompacted: false,
			estimatedUsedTokens: 53000,
			estimatedFreeTokens: 78072,
			estimatedUsagePercent: 40.4,
			tokenCountSource: "server",
		} satisfies LlamaChatContextUsageMetrics;
		tracker.recordContext(context);
		tracker.recordTurn(turn());

		assert.strictEqual(tracker.summary.cacheHitPercent, 75);
		assert.strictEqual(tracker.summary.compactedTurns, 1);
		assert.strictEqual(tracker.summary.repairedToolCalls, 1);
		assert.doesNotMatch(tracker.renderMarkdown("1.3.0", "1.129.0"), /message body/i);
	});
});
