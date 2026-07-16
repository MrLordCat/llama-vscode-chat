import * as assert from "node:assert";
import { compactMessages } from "../context/message-compaction";
import type { OpenAIChatMessage } from "../types";

suite("message compaction", () => {
	test("summarizes old tool payloads without mutating source messages", () => {
		const largeTail = "x".repeat(2400);
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Stable system prompt" },
			{ role: "user", content: "old request" },
			{ role: "tool", name: "read_file", tool_call_id: "1", content: "secret payload".repeat(100) },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: largeTail },
			{ role: "assistant", content: largeTail },
		];

		const compacted = compactMessages(messages, {
			tokenBudget: 100,
			keepLastCount: 2,
			label: "Summary",
			estimateTokens: items => items.reduce((sum, item) => sum + (typeof item.content === "string" ? item.content.length : 0), 0),
		});

		assert.match(String(compacted[1].content), /tool_result read_file/);
		assert.ok(compacted.every(message => typeof message.content !== "string" || message.content.length <= 1203));
		assert.strictEqual(messages[4].content, largeTail);
		assert.strictEqual(messages[5].content, largeTail);
	});
});
