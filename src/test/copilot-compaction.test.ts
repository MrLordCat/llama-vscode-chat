import * as assert from "assert";
import {
	addCopilotCompactionLimit,
	isCopilotCompactionRequest,
} from "../context/copilot-compaction";
import type { OpenAIChatMessage } from "../types";

suite("Copilot compaction request profile", () => {
	test("detects the native Copilot continuation-summary prompt", () => {
		const messages: OpenAIChatMessage[] = [
			{
				role: "system",
				content: "Write a continuation summary for a future context window where the conversation history will be replaced with this summary.",
			},
			{
				role: "user",
				content: "Summarize the conversation history so far, especially the commands that triggered this summarization.",
			},
		];

		assert.strictEqual(isCopilotCompactionRequest(messages), true);
	});

	test("does not classify an ordinary summarization request as compaction", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "user", content: "Summarize the conversation history so far for my weekly report." },
		];

		assert.strictEqual(isCopilotCompactionRequest(messages), false);
	});

	test("adds a bounded concise-summary instruction without mutating input", () => {
		const messages: OpenAIChatMessage[] = [{ role: "user", content: "Summarize the conversation history so far." }];
		const profiled = addCopilotCompactionLimit(messages, 2048);

		assert.strictEqual(messages[0].content, "Summarize the conversation history so far.");
		assert.match(String(profiled[0].content), /under 1536 tokens/);
		assert.match(String(profiled[0].content), /changed files/);
	});
});
