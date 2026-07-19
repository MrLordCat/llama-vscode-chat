import * as assert from "assert";
import type * as vscode from "vscode";

import {
	TokenUsageHistory,
	localDayKey,
	tokenUsageCacheHitPercent,
} from "../token-usage-history";

function createMemento(initial?: unknown): {
	memento: vscode.Memento;
	read: () => unknown;
} {
	let stored = initial;
	return {
		memento: {
			keys: () => stored === undefined ? [] : ["llamacpp.tokenUsageHistory.v1"],
			get: <T>(_key: string, defaultValue?: T): T | undefined =>
				(stored === undefined ? defaultValue : stored) as T | undefined,
			update: async (_key: string, value: unknown) => {
				stored = value;
			},
		} as vscode.Memento,
		read: () => stored,
	};
}

suite("token usage history", () => {
	test("aggregates provider telemetry for today and the last seven local days", async () => {
		const now = new Date(2026, 6, 19, 12).getTime();
		const yesterday = new Date(2026, 6, 18, 12).getTime();
		const eightDaysAgo = new Date(2026, 6, 11, 12).getTime();
		const storage = createMemento();
		const history = new TokenUsageHistory(storage.memento, undefined, () => now);

		history.record({
			provider: "codex",
			inputTokens: 1_000,
			outputTokens: 200,
			cachedInputTokens: 800,
			reasoningOutputTokens: 50,
			recordedAt: now,
		});
		history.record({
			provider: "codex",
			inputTokens: 500,
			outputTokens: 100,
			cachedInputTokens: 250,
			recordedAt: yesterday,
		});
		history.record({
			provider: "codex",
			inputTokens: 100,
			outputTokens: 10,
			cachedInputTokens: 0,
			recordedAt: now,
		});
		history.record({
			provider: "claude",
			inputTokens: 900,
			outputTokens: 300,
			cachedInputTokens: 600,
			cacheWriteInputTokens: 100,
			modelTurns: 3,
			durationMs: 2_500,
			recordedAt: now,
		});
		history.record({
			provider: "local",
			inputTokens: 999,
			outputTokens: 1,
			recordedAt: eightDaysAgo,
		});

		const summary = history.summary;
		assert.strictEqual(summary.today.providers.codex.requests, 2);
		assert.strictEqual(summary.today.providers.codex.reasoningOutputTokens, 50);
		assert.strictEqual(tokenUsageCacheHitPercent(summary.today.providers.codex), 800 / 1_100 * 100);
		assert.strictEqual(summary.today.providers.codex.zeroCacheReadRequests, 1);
		assert.strictEqual(summary.week.providers.codex.inputTokens, 1_600);
		assert.strictEqual(summary.week.providers.codex.cachedInputTokens, 1_050);
		assert.strictEqual(summary.today.providers.claude.cacheWriteInputTokens, 100);
		assert.strictEqual(summary.today.providers.claude.modelTurns, 3);
		assert.strictEqual(summary.today.providers.claude.durationMs, 2_500);
		assert.strictEqual(summary.week.providers.local.requests, 0);
		assert.strictEqual(summary.today.total.requests, 3);
		await history.flush();
		assert.ok(storage.read());
		history.dispose();
	});

	test("persists, reloads, and clears daily aggregates", async () => {
		const now = new Date(2026, 6, 19, 9).getTime();
		const storage = createMemento();
		const first = new TokenUsageHistory(storage.memento, undefined, () => now);
		first.record({
			provider: "deepseek",
			inputTokens: 2_000,
			outputTokens: 400,
			estimated: true,
		});
		await first.flush();
		first.dispose();

		const second = new TokenUsageHistory(storage.memento, undefined, () => now);
		assert.strictEqual(second.summary.today.providers.deepseek.inputTokens, 2_000);
		assert.strictEqual(second.summary.today.providers.deepseek.estimatedRequests, 1);
		second.clear();
		await second.flush();
		assert.strictEqual(second.summary.today.total.requests, 0);
		assert.strictEqual(localDayKey(now), "2026-07-19");
		second.dispose();
	});
});
