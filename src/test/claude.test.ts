import * as assert from "assert";
import * as vscode from "vscode";

import {
	CLAUDE_SUBSCRIPTION_MODELS,
	decodeClaudeModelId,
	encodeClaudeModelId,
	estimateClaudeTokens,
} from "../claude/message-adapter";
import {
	buildClaudeUsageLimits,
	createClaudeReasoningConfigurationSchema,
	resolveClaudeContextLength,
} from "../claude/claude-provider";
import { buildClaudeModelAvailability } from "../claude/availability";
import { isClaudeVsCodeToolName } from "../claude/app-server-client";

type UsageSnapshot = Parameters<typeof buildClaudeUsageLimits>[0];
const AVAILABILITY_NOW = Date.parse("2026-07-19T09:00:00Z");

function availabilityFor(modelId: string, snapshot: UsageSnapshot, now = AVAILABILITY_NOW) {
	return buildClaudeModelAvailability(modelId, snapshot, AVAILABILITY_NOW, undefined, undefined, now);
}

function usageSnapshot(rateLimits: Record<string, unknown>): UsageSnapshot {
	return {
		subscription_type: "pro",
		rate_limits_available: true,
		rate_limits: rateLimits,
	} as unknown as UsageSnapshot;
}

suite("Claude subscription provider", () => {
	test("allows only tools hosted by the native VS Code MCP server", () => {
		assert.strictEqual(isClaudeVsCodeToolName("mcp__vscode__read_file"), true);
		assert.strictEqual(isClaudeVsCodeToolName("Read"), false);
		assert.strictEqual(isClaudeVsCodeToolName("Bash"), false);
		assert.strictEqual(isClaudeVsCodeToolName("mcp__other__write_file"), false);
	});

	test("round-trips provider model ids and advertises the current families", () => {
		assert.strictEqual(
			decodeClaudeModelId(encodeClaudeModelId("claude-fable-5")),
			"claude-fable-5"
		);
		assert.strictEqual(decodeClaudeModelId("other::claude-fable-5"), undefined);
		assert.ok(CLAUDE_SUBSCRIPTION_MODELS.some(model => model.id === "claude-sonnet-4-5"));
		assert.ok(CLAUDE_SUBSCRIPTION_MODELS.some(model => model.id === "claude-fable-5"));
	});

	test("estimates text, native tool calls, and native tool results", () => {
		const textTokens = estimateClaudeTokens("x".repeat(400));
		assert.strictEqual(textTokens, 100);

		const toolMessage = vscode.LanguageModelChatMessage.Assistant([
			new vscode.LanguageModelToolCallPart("call-1", "read_file", {
				filePath: "README.md",
				startLine: 1,
				endLine: 100,
			}),
		]);
		assert.ok(estimateClaudeTokens(toolMessage) > 10);

		const resultMessage = vscode.LanguageModelChatMessage.User([
			new vscode.LanguageModelToolResultPart("call-1", [
				new vscode.LanguageModelTextPart("result ".repeat(100)),
			]),
		]);
		assert.ok(estimateClaudeTokens(resultMessage) > 100);
	});

	test("builds separate 5h, weekly, and model-scoped usage limits", () => {
		const snapshot = {
			subscription_type: "max",
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 42.4, resets_at: "2026-07-19T18:00:00Z" },
				seven_day: { utilization: 87, resets_at: "2026-07-25T09:47:00Z" },
				seven_day_opus: { utilization: null, resets_at: null },
				model_scoped: [
					{ display_name: "Fable", utilization: 12, resets_at: "2026-07-25T09:47:00Z" },
				],
			},
		} as unknown as UsageSnapshot;

		const limits = buildClaudeUsageLimits(snapshot);
		assert.deepStrictEqual(
			limits.map(limit => limit.label),
			["Session Limit (5h)", "Weekly Limit", "Weekly Fable Limit"]
		);
		assert.ok(limits[0].description.startsWith("42% used / resets "));
		assert.ok(limits[1].description.startsWith("87% used / resets "));
		assert.ok(limits[2].description.startsWith("12% used / resets "));
	});

	test("returns no usage limits when the plan does not expose them", () => {
		assert.deepStrictEqual(buildClaudeUsageLimits(undefined), []);
		const apiKeySnapshot = {
			subscription_type: null,
			rate_limits_available: false,
			rate_limits: null,
		} as unknown as UsageSnapshot;
		assert.deepStrictEqual(buildClaudeUsageLimits(apiKeySnapshot), []);
	});

	test("advertises native thinking effort choices for Claude models", () => {
		const sonnet = createClaudeReasoningConfigurationSchema("claude-sonnet-4-5") as {
			properties: { reasoningEffort: { enum: string[]; default: string } };
		};
		assert.deepStrictEqual(sonnet.properties.reasoningEffort.enum, ["low", "medium", "high"]);
		assert.strictEqual(sonnet.properties.reasoningEffort.default, "high");

		const opus = createClaudeReasoningConfigurationSchema("claude-opus-4-8", "max") as typeof sonnet;
		assert.deepStrictEqual(opus.properties.reasoningEffort.enum, ["low", "medium", "high", "xhigh", "max"]);
		assert.strictEqual(opus.properties.reasoningEffort.default, "max");
	});

	test("caps observed Claude context at the configured maximum", () => {
		assert.strictEqual(resolveClaudeContextLength(258_400, 1_000_000), 258_400);
		assert.strictEqual(resolveClaudeContextLength(524_288, 200_000), 200_000);
		assert.strictEqual(resolveClaudeContextLength(131_072), 131_072);
	});

	test("marks every Claude profile unavailable when the common 5-hour window is exhausted", () => {
		const snapshot = usageSnapshot({
			five_hour: { utilization: 100, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
		});
		for (const model of CLAUDE_SUBSCRIPTION_MODELS) {
			const availability = availabilityFor(model.id, snapshot);
			assert.strictEqual(availability.state, "unavailable", model.id);
			assert.ok(availability.reason.includes("5-hour limit 100%"));
			assert.strictEqual(availability.unavailableUntil, "2026-07-19T10:50:00.000Z");
		}
	});

	test("applies model-specific Claude windows only to their matching family", () => {
		const base = {
			five_hour: { utilization: 20, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
		};
		const cases = [
			{
				blocked: "claude-opus-4-8",
				other: "claude-sonnet-4-5",
				snapshot: usageSnapshot({ ...base, seven_day_opus: { utilization: 100, resets_at: "2026-07-22T23:00:00Z" } }),
			},
			{
				blocked: "claude-sonnet-4-5",
				other: "claude-haiku-4-5",
				snapshot: usageSnapshot({ ...base, seven_day_sonnet: { utilization: 100, resets_at: "2026-07-22T23:00:00Z" } }),
			},
			{
				blocked: "claude-fable-5",
				other: "claude-opus-4-8",
				snapshot: usageSnapshot({
					...base,
					model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-07-22T23:00:00Z" }],
				}),
			},
		];
		for (const value of cases) {
			assert.strictEqual(availabilityFor(value.blocked, value.snapshot).state, "unavailable", value.blocked);
			assert.strictEqual(availabilityFor(value.other, value.snapshot).state, "available", value.other);
		}
	});

	test("does not block on ambiguous scoped labels, stale snapshots, or an expired full window", () => {
		const ambiguous = usageSnapshot({
			five_hour: { utilization: 20, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
			model_scoped: [{ display_name: "Premium Fable models", utilization: 100, resets_at: "2026-07-22T23:00:00Z" }],
		});
		assert.strictEqual(availabilityFor("claude-fable-5", ambiguous).state, "available");

		const stale = buildClaudeModelAvailability(
			"claude-opus-4-8",
			ambiguous,
			AVAILABILITY_NOW - 180_000,
			undefined,
			undefined,
			AVAILABILITY_NOW
		);
		assert.strictEqual(stale.state, "unknown");

		const expired = usageSnapshot({
			five_hour: { utilization: 100, resets_at: "2026-07-19T08:59:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
		});
		assert.strictEqual(availabilityFor("claude-opus-4-8", expired).state, "unknown");
	});

	test("keeps Claude available after subscription exhaustion when paid extra usage has capacity", () => {
		const snapshot = usageSnapshot({
			five_hour: { utilization: 100, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
			extra_usage: { is_enabled: true, utilization: 25 },
		});
		const availability = availabilityFor("claude-opus-4-8", snapshot);
		assert.strictEqual(availability.state, "available");
		assert.ok(availability.reason.includes("paid extra usage is enabled"));
	});
});
