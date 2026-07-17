import * as assert from "assert";

import {
	buildKnowledgeSystemPrompt,
	formatLocalDate,
	injectKnowledgeSystemPrompt,
	normalizeKnowledgeMode,
} from "../context/system-prompt";
import type { OpenAIChatMessage } from "../types";

suite("knowledge system prompt", () => {
	test("normalizes unknown modes to adaptive", () => {
		assert.strictEqual(normalizeKnowledgeMode("strict"), "strict");
		assert.strictEqual(normalizeKnowledgeMode("off"), "off");
		assert.strictEqual(normalizeKnowledgeMode("unexpected"), "adaptive");
	});

	test("builds an adaptive cache-stable verification policy", () => {
		const prompt = buildKnowledgeSystemPrompt({
			mode: "adaptive",
			currentDate: "2026-07-17",
		});

		assert.ok(prompt?.includes("Current date: 2026-07-17"));
		assert.ok(prompt?.includes("official documentation"));
		assert.ok(prompt?.includes("direct source URLs"));
		assert.ok(prompt?.includes("Do not browse stable facts"));
	});

	test("makes strict mode require evidence for changing technical claims", () => {
		const prompt = buildKnowledgeSystemPrompt({
			mode: "strict",
			currentDate: "2026-07-17",
		});

		assert.ok(prompt?.includes("Knowledge verification mode: strict"));
		assert.ok(prompt?.includes("verify it with available web or source tools"));
		assert.ok(prompt?.includes("pinned source revisions"));
		assert.ok(prompt?.includes("reproducible test"));
	});

	test("keeps custom instructions available when built-in policy is off", () => {
		assert.strictEqual(buildKnowledgeSystemPrompt({ mode: "off", currentDate: "2026-07-17" }), undefined);
		assert.strictEqual(
			buildKnowledgeSystemPrompt({
				mode: "off",
				currentDate: "2026-07-17",
				customPrompt: "Prefer concise patches.",
			}),
			"Additional user-configured instructions:\nPrefer concise patches."
		);
	});

	test("prepends policy to the existing system prefix without mutating input", () => {
		const input: OpenAIChatMessage[] = [
			{ role: "system", content: "Host instructions" },
			{ role: "user", content: "Audit this project" },
		];
		const output = injectKnowledgeSystemPrompt(input, "Stable provider policy");

		assert.notStrictEqual(output, input);
		assert.strictEqual(input[0].content, "Host instructions");
		assert.strictEqual(output[0].role, "system");
		assert.strictEqual(output[0].content, "Stable provider policy\n\nHost instructions");
		assert.strictEqual(output[1].content, "Audit this project");
	});

	test("creates the first system message when the host supplied none", () => {
		const output = injectKnowledgeSystemPrompt(
			[{ role: "user", content: "Check current APIs" }],
			"Stable provider policy"
		);

		assert.deepStrictEqual(output[0], { role: "system", content: "Stable provider policy" });
		assert.strictEqual(output[1].role, "user");
	});

	test("formats local dates without locale-dependent text", () => {
		assert.strictEqual(formatLocalDate(new Date(2026, 6, 7, 12, 0, 0)), "2026-07-07");
	});
});
