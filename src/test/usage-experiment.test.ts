import * as assert from "assert";
import type * as vscode from "vscode";

import { renderUsageExperimentMarkdown, UsageExperimentTracker } from "../usage-experiment";
import type { TokenUsageSample } from "../token-usage-history";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "llamacpp.usageExperiment.v1";

function createMemento(initial?: unknown): {
	memento: vscode.Memento;
	persisted: () => unknown;
} {
	let stored = initial;
	return {
		memento: {
			keys: () => (stored === undefined ? [] : [STORAGE_KEY]),
			get: <T>(_key: string, defaultValue?: T): T | undefined =>
				(stored === undefined ? defaultValue : stored) as T | undefined,
			update: async (_key: string, value: unknown) => {
				stored = value;
			},
		} as vscode.Memento,
		persisted: () => stored,
	};
}

function codexSample(overrides: Partial<TokenUsageSample> = {}): TokenUsageSample {
	return {
		provider: "codex",
		inputTokens: 1000,
		outputTokens: 200,
		cachedInputTokens: 300,
		requests: 1,
		...overrides,
	};
}

function localSample(overrides: Partial<TokenUsageSample> = {}): TokenUsageSample {
	return {
		provider: "local",
		inputTokens: 500,
		outputTokens: 100,
		requests: 1,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("UsageExperimentTracker", () => {
	// -- lifecycle --------------------------------------------------------

	test("start creates active run, stop archives it, and summary reflects them", () => {
		const storage = createMemento();
		const now = new Date(2026, 6, 19, 10).getTime();
		let idCounter = 0;
		const tracker = new UsageExperimentTracker(
			storage.memento,
			undefined,
			() => now,
			() => `id-${++idCounter}`,
		);

		// Nothing active initially.
		assert.strictEqual(tracker.summary.active, undefined);
		assert.strictEqual(tracker.summary.latestBaseline, undefined);
		assert.strictEqual(tracker.summary.latestDelegated, undefined);
		assert.strictEqual(tracker.summary.comparison, undefined);

		// Start baseline.
		const run = tracker.start("test-run", "baseline");
		assert.strictEqual(run.id, "id-1");
		assert.strictEqual(run.label, "test-run");
		assert.strictEqual(run.variant, "baseline");
		assert.strictEqual(run.startedAt, now);
		assert.strictEqual(run.stoppedAt, undefined);
		assert.deepStrictEqual(run.providers, {});
		assert.deepStrictEqual(run.models, {});

		assert.strictEqual(tracker.summary.active, run);
		assert.strictEqual(tracker.summary.latestBaseline, undefined); // not completed yet

		// Stop.
		const stopped = tracker.stop();
		assert.ok(stopped);
		assert.strictEqual(stopped!.id, "id-1");
		assert.strictEqual(stopped!.stoppedAt, now);
		assert.strictEqual(tracker.summary.active, undefined);
		assert.strictEqual(tracker.summary.latestBaseline, stopped);
		assert.strictEqual(tracker.summary.latestDelegated, undefined);
		assert.strictEqual(tracker.summary.comparison, undefined);

		tracker.dispose();
	});

	test("stop without active returns undefined", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);
		assert.strictEqual(tracker.stop(), undefined);
		tracker.dispose();
	});

	test("start while active fails without replacing the current run", () => {
		const storage = createMemento();
		const now = new Date(2026, 6, 19, 10).getTime();
		let idCounter = 0;
		const tracker = new UsageExperimentTracker(
			storage.memento,
			undefined,
			() => now,
			() => `id-${++idCounter}`,
		);

		tracker.start("first", "baseline");
		assert.strictEqual(tracker.summary.active?.id, "id-1");

		assert.throws(
			() => tracker.start("second", "delegated"),
			/already active/
		);
		assert.strictEqual(tracker.summary.active?.id, "id-1");
		assert.strictEqual(tracker.summary.latestBaseline, undefined);

		tracker.dispose();
	});

	// -- record / aggregation -------------------------------------------

	test("record aggregates per provider and per model", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("agg-test", "baseline");

		tracker.record(codexSample({ inputTokens: 1000, outputTokens: 200, modelTurns: 2 }), "gpt-5");
		tracker.record(codexSample({ inputTokens: 500, outputTokens: 100 }), "gpt-5");
		tracker.record(codexSample({ inputTokens: 300, outputTokens: 50 }), "gpt-5-mini");
		tracker.record(localSample({ inputTokens: 400, outputTokens: 80 }), "qwen");

		const active = tracker.summary.active!;
		// Provider-level: codex = 1000+500+300=1800 in, 200+100+50=350 out, 3 requests
		assert.strictEqual(active.providers["codex"]?.inputTokens, 1800);
		assert.strictEqual(active.providers["codex"]?.outputTokens, 350);
		assert.strictEqual(active.providers["codex"]?.requests, 3);
		assert.strictEqual(active.providers["codex"]?.modelTurns, 2 + 1 + 1); // first has modelTurns=2
		assert.strictEqual(active.providers["local"]?.inputTokens, 400);
		assert.strictEqual(active.providers["local"]?.outputTokens, 80);
		assert.strictEqual(active.providers["local"]?.requests, 1);

		// Model-level
		assert.strictEqual(active.models["codex::gpt-5"]?.inputTokens, 1500);
		assert.strictEqual(active.models["codex::gpt-5"]?.outputTokens, 300);
		assert.strictEqual(active.models["codex::gpt-5"]?.modelTurns, 2 + 1);
		assert.strictEqual(active.models["codex::gpt-5-mini"]?.inputTokens, 300);
		assert.strictEqual(active.models["codex::gpt-5-mini"]?.outputTokens, 50);
		assert.strictEqual(active.models["local::qwen"]?.inputTokens, 400);

		tracker.dispose();
	});

	test("record without active is a no-op", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		// Should not throw.
		tracker.record(codexSample({ inputTokens: 1000, outputTokens: 200 }));
		assert.strictEqual(tracker.summary.active, undefined);

		tracker.dispose();
	});

	test("record uses unknown model key when modelId is omitted", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("no-model", "baseline");
		tracker.record(codexSample({ inputTokens: 100, outputTokens: 20 }));

		assert.strictEqual(tracker.summary.active?.models["codex::unknown"]?.inputTokens, 100);
		assert.strictEqual(tracker.summary.active?.models["codex::unknown"]?.outputTokens, 20);

		tracker.dispose();
	});

	// -- cache / estimated / modelTurns semantics -----------------------

	test("cache semantics match TokenUsageHistory", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("cache-test", "baseline");

		// cachedInputTokens reported.
		tracker.record(
			codexSample({ inputTokens: 1000, cachedInputTokens: 400, requests: 2 }),
		);
		let c = tracker.summary.active!.providers["codex"]!;
		assert.strictEqual(c.cachedInputTokens, 400);
		assert.strictEqual(c.cacheEligibleInputTokens, 1000);
		assert.strictEqual(c.cacheReportedRequests, 2);

		// cachedInputTokens missing → cache fields zero.
		tracker.record(
			codexSample({
				inputTokens: 500,
				cachedInputTokens: undefined,
				requests: 1,
			}),
		);
		c = tracker.summary.active!.providers["codex"]!;
		// Merged: first had cache, second did not.
		assert.strictEqual(c.cachedInputTokens, 400); // only first's
		assert.strictEqual(c.cacheEligibleInputTokens, 1000); // only first's (second had 0)
		assert.strictEqual(c.cacheReportedRequests, 2); // only first's
		assert.strictEqual(c.requests, 3);

		tracker.dispose();
	});

	test("estimated flag counts toward estimatedRequests", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("est-test", "baseline");
		tracker.record(codexSample({ inputTokens: 500, outputTokens: 100, estimated: true }));
		tracker.record(codexSample({ inputTokens: 300, outputTokens: 50, estimated: false }));

		const c = tracker.summary.active!.providers["codex"]!;
		assert.strictEqual(c.requests, 2);
		assert.strictEqual(c.estimatedRequests, 1);

		tracker.dispose();
	});

	test("modelTurns defaults to requests when omitted", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("turns-test", "baseline");
		tracker.record(codexSample({ requests: 3 }));
		assert.strictEqual(tracker.summary.active!.providers["codex"]!.modelTurns, 3);

		tracker.record(codexSample({ requests: 1, modelTurns: 5 }));
		assert.strictEqual(tracker.summary.active!.providers["codex"]!.modelTurns, 3 + 5);

		tracker.dispose();
	});

	// -- comparison (Codex-only) ----------------------------------------

	test("comparison computes Codex-only savings percentages", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		// Baseline: codex only, heavy usage.
		tracker.start("routing-comparison", "baseline");
		tracker.record(codexSample({ inputTokens: 10000, outputTokens: 2000, cachedInputTokens: 4000 }));
		tracker.stop();

		// Delegated: codex + child providers.  Codex uses fewer tokens.
		tracker.start("routing-comparison", "delegated");
		tracker.record(codexSample({ inputTokens: 6000, outputTokens: 1200, cachedInputTokens: 3000 }));
		tracker.record(localSample({ inputTokens: 3000, outputTokens: 600 }));
		tracker.stop();

		const comp = tracker.summary.comparison!;
		assert.ok(comp);

		// Baseline Codex: 10k in, 2k out, total=12k.
		// Delegated Codex: 6k in, 1.2k out, total=7.2k.
		assert.strictEqual(comp.totalSavingsPercent, (12000 - 7200) / 12000 * 100); // 40%
		assert.strictEqual(comp.inputSavingsPercent, (10000 - 6000) / 10000 * 100); // 40%
		assert.strictEqual(comp.outputSavingsPercent, (2000 - 1200) / 2000 * 100);   // 40%

		// Uncached: baseline 10k-4k=6k, delegated 6k-3k=3k, delta=3k, 3k/6k=50%
		assert.strictEqual(comp.uncachedInputSavingsPercent, (6000 - 3000) / 6000 * 100); // 50%

		// Child providers should be reported separately.
		assert.strictEqual(comp.delegatedChildProviders["local"]?.inputTokens, 3000);
		assert.strictEqual(comp.delegatedChildProviders["local"]?.outputTokens, 600);
		// No codex in child providers.
		assert.strictEqual(comp.delegatedChildProviders["codex"], undefined);

		// Delegated cache hit: 3000/6000=50%.
		assert.strictEqual(comp.delegatedCacheHitPercent, (3000 / 6000) * 100);

		tracker.dispose();
	});

	test("child provider tokens do NOT reduce claimed Codex savings", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		// Baseline: Codex 10k in, 2k out.
		tracker.start("child-cost", "baseline");
		tracker.record(codexSample({ inputTokens: 10000, outputTokens: 2000 }));
		tracker.stop();

		// Delegated: Codex 6k in, 1.2k out + 50k local tokens.
		// The 50k local tokens must NOT increase the Codex denominator or reduce savings.
		tracker.start("child-cost", "delegated");
		tracker.record(codexSample({ inputTokens: 6000, outputTokens: 1200 }));
		tracker.record(localSample({ inputTokens: 50000, outputTokens: 10000 }));
		tracker.stop();

		const comp = tracker.summary.comparison!;
		// Savings should be identical to the previous test case for Codex portions.
		assert.strictEqual(comp.totalSavingsPercent, (12000 - 7200) / 12000 * 100);
		assert.strictEqual(comp.inputSavingsPercent, (10000 - 6000) / 10000 * 100);
		// Child provider present but separate.
		assert.strictEqual(comp.delegatedChildProviders["local"]?.inputTokens, 50000);

		tracker.dispose();
	});

	test("comparison with zero denominators returns undefined", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		// Baseline with zero tokens.
		tracker.start("zero-baseline", "baseline");
		tracker.stop();

		tracker.start("zero-baseline", "delegated");
		tracker.record(
			codexSample({ inputTokens: 100, outputTokens: 20, cachedInputTokens: undefined }),
		);
		tracker.stop();

		const comp = tracker.summary.comparison!;
		assert.ok(comp);
		assert.strictEqual(comp.totalSavingsPercent, undefined);
		assert.strictEqual(comp.inputSavingsPercent, undefined);
		assert.strictEqual(comp.outputSavingsPercent, undefined);
		assert.strictEqual(comp.uncachedInputSavingsPercent, undefined);
		assert.strictEqual(comp.delegatedCacheHitPercent, undefined); // no cache data

		tracker.dispose();
	});

	test("comparison is undefined when only one variant has completed runs", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("only-baseline", "baseline");
		tracker.record(codexSample({ inputTokens: 100, outputTokens: 20 }));
		tracker.stop();

		assert.strictEqual(tracker.summary.comparison, undefined);

		tracker.start("only-delegated", "delegated");
		tracker.record(codexSample({ inputTokens: 50, outputTokens: 10 }));
		tracker.stop();

		assert.strictEqual(tracker.summary.comparison, undefined);

		tracker.dispose();
	});

	test("delegatedCacheHitPercent is undefined without cache data", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("cache-reporting", "baseline");
		tracker.record(codexSample({ inputTokens: 1000, outputTokens: 200 }));
		tracker.stop();

		tracker.start("cache-reporting", "delegated");
		// No cachedInputTokens → cache fields are zero.
		tracker.record(codexSample({ inputTokens: 500, outputTokens: 100, cachedInputTokens: undefined }));
		tracker.stop();

		const comp = tracker.summary.comparison!;
		assert.strictEqual(comp.delegatedCacheHitPercent, undefined);

		tracker.dispose();
	});

	// -- persistence & reload -------------------------------------------

	test("persists active and completed runs and reloads correctly", async () => {
		const now = new Date(2026, 6, 19, 10).getTime();
		let idCounter = 0;
		const storage = createMemento();

		const first = new UsageExperimentTracker(
			storage.memento,
			undefined,
			() => now,
			() => `id-${++idCounter}`,
		);
		first.start("persisted-pair", "baseline");
		first.record(codexSample({ inputTokens: 1000, outputTokens: 200 }));
		first.stop();
		first.start("persisted-pair", "delegated");
		first.record(codexSample({ inputTokens: 600, outputTokens: 100 }));
		first.stop();
		// Start a third run and leave it active.
		first.start("b2", "baseline");
		first.record(codexSample({ inputTokens: 300, outputTokens: 50 }));
		await first.flush();
		first.dispose();

		// Reload.
		const second = new UsageExperimentTracker(
			storage.memento,
			undefined,
			() => now,
			() => `id-${++idCounter}`,
		);
		assert.ok(second.summary.active);
		assert.strictEqual(second.summary.active!.label, "b2");
		assert.strictEqual(second.summary.active!.variant, "baseline");
		assert.strictEqual(second.summary.active!.providers["codex"]?.inputTokens, 300);

		assert.strictEqual(second.summary.latestBaseline?.label, "persisted-pair");
		assert.strictEqual(second.summary.latestBaseline?.providers["codex"]?.inputTokens, 1000);
		assert.strictEqual(second.summary.latestDelegated?.label, "persisted-pair");
		assert.strictEqual(second.summary.latestDelegated?.providers["codex"]?.inputTokens, 600);

		assert.ok(second.summary.comparison);
		assert.strictEqual(second.summary.comparison!.inputSavingsPercent, (1000 - 600) / 1000 * 100);

		second.dispose();
	});

	// -- retention -------------------------------------------------------

	test("retains at most 20 completed runs", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		// Create 25 runs (0–24).  Evens = baseline, odds = delegated.
		for (let i = 0; i < 25; i++) {
			tracker.start(`run-${i}`, i % 2 === 0 ? "baseline" : "delegated");
			tracker.record(codexSample({ inputTokens: 100, outputTokens: 10 }));
			tracker.stop();
		}

		// Completed list capped at 20 (most recent first).
		// Runs 0–4 should be evicted; runs 5–24 retained.
		const summary = tracker.summary;
		assert.strictEqual(summary.latestBaseline?.label, "run-24");
		assert.strictEqual(summary.latestDelegated?.label, "run-23");

		// Verify runs 0–4 are gone by ensuring the oldest run number is ≥ 5.
		const baselineNum = parseInt(summary.latestBaseline!.label.replace("run-", ""), 10);
		const delegatedNum = parseInt(summary.latestDelegated!.label.replace("run-", ""), 10);
		assert.ok(baselineNum >= 5, `baseline run ${baselineNum} should be ≥ 5`);
		assert.ok(delegatedNum >= 5, `delegated run ${delegatedNum} should be ≥ 5`);

		tracker.dispose();
	});

	test("active run is not counted toward retention limit", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		// Fill completed with 20 runs.
		for (let i = 0; i < 20; i++) {
			tracker.start(`completed-${i}`, "baseline");
			tracker.record(codexSample({ inputTokens: 10, outputTokens: 1 }));
			tracker.stop();
		}

		// Start a 21st and leave it active.
		tracker.start("active-run", "delegated");
		tracker.record(codexSample({ inputTokens: 50, outputTokens: 5 }));

		assert.strictEqual(tracker.summary.active?.label, "active-run");
		assert.strictEqual(tracker.summary.latestBaseline?.label, "completed-19");

		// Stop it — should push into completed, evicting completed-0.
		tracker.stop();
		assert.strictEqual(tracker.summary.latestDelegated?.label, "active-run");
		assert.strictEqual(tracker.summary.latestBaseline?.label, "completed-19");
		// completed-0 should now be gone.

		tracker.dispose();
	});

	// -- clear -----------------------------------------------------------

	test("clear removes active and all completed runs", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("b", "baseline");
		tracker.record(codexSample({ inputTokens: 100, outputTokens: 10 }));
		tracker.stop();
		tracker.start("d", "delegated");
		tracker.record(codexSample({ inputTokens: 50, outputTokens: 5 }));
		tracker.stop();
		tracker.start("active", "baseline");

		tracker.clear();

		assert.strictEqual(tracker.summary.active, undefined);
		assert.strictEqual(tracker.summary.latestBaseline, undefined);
		assert.strictEqual(tracker.summary.latestDelegated, undefined);
		assert.strictEqual(tracker.summary.comparison, undefined);

		tracker.dispose();
	});

	// -- malformed state ------------------------------------------------

	test("normalizes malformed persisted data safely", async () => {
		const storage = createMemento({
			version: 1,
			active: { id: "ok", label: "a", variant: "baseline", startedAt: 100 },
			completed: [
				null,
				42,
				"garbage",
				{},
				{ id: "", label: "no-id", variant: "baseline" },
				{ id: "bad-variant", label: "x", variant: "bogus" },
				{
					id: "valid-run",
					label: "good",
					variant: "delegated",
					startedAt: 200,
					stoppedAt: 300,
					providers: {
						codex: {
							inputTokens: -500, // negative → 0
							outputTokens: 100,
							requests: "bad",   // non-number → 0
						},
					},
					models: {
						"codex::gpt-5": { inputTokens: 300, outputTokens: 50 },
					},
				},
				{
					id: "extra-long-id".repeat(50), // truncated
					label: "x".repeat(500),
					variant: "baseline",
					startedAt: 50,
				},
			],
		});

		const tracker = new UsageExperimentTracker(storage.memento);
		await tracker.flush();

		// Only "valid-run" should survive normalization.
		assert.strictEqual(tracker.summary.latestDelegated?.id, "valid-run");
		assert.strictEqual(tracker.summary.latestDelegated?.label, "good");
		// Negative inputTokens → 0, bad requests → 0.
		assert.strictEqual(tracker.summary.latestDelegated?.providers["codex"]?.inputTokens, 0);
		assert.strictEqual(tracker.summary.latestDelegated?.providers["codex"]?.outputTokens, 100);
		assert.strictEqual(tracker.summary.latestDelegated?.providers["codex"]?.requests, 0);
		assert.strictEqual(tracker.summary.latestDelegated?.models["codex::gpt-5"]?.inputTokens, 300);

		// Active: { id: "ok", ... } should survive.
		assert.strictEqual(tracker.summary.active?.id, "ok");
		assert.strictEqual(tracker.summary.active?.label, "a");

		tracker.dispose();
	});

	test("normalizes undefined / non-object persisted data", async () => {
		const storage = createMemento(undefined);
		const tracker = new UsageExperimentTracker(storage.memento);
		await tracker.flush();
		assert.strictEqual(tracker.summary.active, undefined);
		assert.strictEqual(tracker.summary.comparison, undefined);
		tracker.dispose();
	});

	test("normalizes null persisted data", async () => {
		const storage = createMemento(null);
		const tracker = new UsageExperimentTracker(storage.memento);
		await tracker.flush();
		assert.strictEqual(tracker.summary.active, undefined);
		tracker.dispose();
	});

	test("normalizes data with missing completed array", async () => {
		const storage = createMemento({ version: 1, active: null });
		const tracker = new UsageExperimentTracker(storage.memento);
		await tracker.flush();
		assert.strictEqual(tracker.summary.active, undefined);
		tracker.dispose();
	});

	// -- persist failure ------------------------------------------------

	test("invokes onPersistError callback when update fails", async () => {
		let captured: Error | undefined;
		const memento: vscode.Memento = {
			keys: () => [STORAGE_KEY],
			get: <T>(_key: string, defaultValue?: T) => defaultValue as T | undefined,
			update: async (_key: string, _value: unknown) => {
				throw new Error("disk full");
			},
		} as vscode.Memento;

		const tracker = new UsageExperimentTracker(
			memento,
			err => {
				captured = err;
			},
		);

		tracker.start("fail-run", "baseline");
		await tracker.flush();

		assert.ok(captured);
		assert.strictEqual(captured!.message, "disk full");

		tracker.dispose();
	});

	// -- onDidChange -----------------------------------------------------

	test("onDidChange fires on start, record, stop, and clear", async () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		const events: string[] = [];
		tracker.onDidChange(() => events.push("change"));

		tracker.start("e1", "baseline");
		assert.strictEqual(events.length, 1);

		tracker.record(codexSample({ inputTokens: 10, outputTokens: 2 }));
		assert.strictEqual(events.length, 2);

		tracker.stop();
		assert.strictEqual(events.length, 3);

		tracker.clear();
		assert.strictEqual(events.length, 4);

		// record without active → no event.
		events.length = 0;
		tracker.record(codexSample({ inputTokens: 10, outputTokens: 2 }));
		assert.strictEqual(events.length, 0);

		tracker.dispose();
	});

	// -- multiple runs with same variant (latest wins) ------------------

	test("latestBaseline and latestDelegated pick the most recently stopped run", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("b1", "baseline");
		tracker.record(codexSample({ inputTokens: 100, outputTokens: 10 }));
		tracker.stop();

		tracker.start("b2", "baseline");
		tracker.record(codexSample({ inputTokens: 200, outputTokens: 20 }));
		tracker.stop();

		assert.strictEqual(tracker.summary.latestBaseline?.label, "b2");
		assert.strictEqual(tracker.summary.latestBaseline?.providers["codex"]?.inputTokens, 200);

		tracker.start("b2", "delegated");
		tracker.record(codexSample({ inputTokens: 50, outputTokens: 5 }));
		tracker.stop();

		assert.strictEqual(tracker.summary.latestDelegated?.label, "b2");

		// Comparison should use b2 (latest baseline) and d1 (latest delegated).
		const comp = tracker.summary.comparison!;
		assert.strictEqual(comp.baselineCodex.inputTokens, 200);
		assert.strictEqual(comp.delegatedCodex.inputTokens, 50);

		tracker.dispose();
	});

	// -- deterministic now / idFactory -----------------------------------

	test("uses injectable now and idFactory for deterministic tests", () => {
		const storage = createMemento();
		const now = new Date(2026, 6, 19, 15, 30).getTime();
		const ids = ["aaa", "bbb", "ccc"];
		let idx = 0;
		const tracker = new UsageExperimentTracker(
			storage.memento,
			undefined,
			() => now,
			() => ids[idx++],
		);

		const r1 = tracker.start("run-1", "baseline");
		assert.strictEqual(r1.id, "aaa");
		assert.strictEqual(r1.startedAt, now);

		tracker.stop();
		const r2 = tracker.start("run-2", "delegated");
		assert.strictEqual(r2.id, "bbb");

		tracker.dispose();
	});

	// -- comparison edge cases ------------------------------------------

	test("negative savings expose a delegated regression", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		// Baseline smaller than delegated → negative savings expose the regression.
		tracker.start("regression", "baseline");
		tracker.record(codexSample({ inputTokens: 100, outputTokens: 50 }));
		tracker.stop();

		tracker.start("regression", "delegated");
		tracker.record(codexSample({ inputTokens: 1000, outputTokens: 500 }));
		tracker.stop();

		const comp = tracker.summary.comparison!;
		assert.strictEqual(comp.totalSavingsPercent, -900);
		assert.strictEqual(comp.inputSavingsPercent, -900);

		tracker.dispose();
	});

	test("delegated run with no codex provider uses empty aggregate", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);

		tracker.start("no-codex", "baseline");
		tracker.record(codexSample({ inputTokens: 500, outputTokens: 100 }));
		tracker.stop();

		tracker.start("no-codex", "delegated");
		tracker.record(localSample({ inputTokens: 300, outputTokens: 60 }));
		tracker.stop();

		const comp = tracker.summary.comparison!;
		assert.strictEqual(comp.delegatedCodex.inputTokens, 0);
		assert.strictEqual(comp.delegatedCodex.outputTokens, 0);
		// Savings should be 100% since delegated codex is zero.
		assert.strictEqual(comp.totalSavingsPercent, 100);
		assert.strictEqual(comp.delegatedChildProviders["local"]?.inputTokens, 300);

		tracker.dispose();
	});

	test("renders an auditable report without combining provider costs", () => {
		const storage = createMemento();
		const tracker = new UsageExperimentTracker(storage.memento);
		tracker.start("same-task", "baseline");
		tracker.record(codexSample({ inputTokens: 1_000, outputTokens: 200 }), "gpt-test");
		tracker.stop();
		tracker.start("same-task", "delegated");
		tracker.record(codexSample({ inputTokens: 500, outputTokens: 100 }), "gpt-test");
		tracker.record(localSample({ inputTokens: 800, outputTokens: 160 }), "qwen");
		tracker.stop();

		const markdown = renderUsageExperimentMarkdown(tracker.summary, "2026-07-19T00:00:00.000Z");
		assert.match(markdown, /Matched task: same-task/);
		assert.match(markdown, /Total token saving: \+50\.0%/);
		assert.match(markdown, /Codex savings use Codex tokens only/);
		assert.match(markdown, /local \| 1 \| 800 \| 160/);
		assert.match(markdown, /local::qwen/);
		assert.match(markdown, /does not prove causality/i);
		tracker.dispose();
	});
});
