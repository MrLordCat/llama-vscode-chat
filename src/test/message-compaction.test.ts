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

	test("keeps code decisions and file paths in old assistant summaries", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Stable system prompt" },
			{ role: "user", content: "Please fix the provider" },
			{
				role: "assistant",
				content: [
					"Implemented the retry fix in src/transport/openai-http.ts.",
					"```ts",
					"export function retry() {",
					"  return true;",
					"}",
					"```",
					"Next: add regression tests.",
				].join("\n"),
			},
			{ role: "user", content: "new request" },
			{ role: "assistant", content: "new answer" },
		];

		const compacted = compactMessages(messages, {
			tokenBudget: 20_000,
			keepLastCount: 2,
			label: "Summary",
			estimateTokens: () => 100,
		});
		const summary = String(compacted[1].content);
		assert.match(summary, /src\/transport\/openai-http\.ts/);
		assert.match(summary, /add regression tests/i);
		assert.match(summary, /export function retry/);
	});

	test("drops complete turns instead of leaving orphaned tool results", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Stable system prompt" },
			{ role: "user", content: "old request" },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "inspect file" },
			{
				role: "assistant",
				tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "call-1", name: "read_file", content: "file contents" },
			{ role: "assistant", content: "inspection complete" },
			{ role: "user", content: "new request" },
			{ role: "assistant", content: "new answer" },
		];

		const compacted = compactMessages(messages, {
			tokenBudget: 4,
			keepLastCount: 6,
			label: "Summary",
			estimateTokens: items => items.length,
		});

		assert.deepStrictEqual(
			compacted.filter(message => message.role !== "system").map(message => message.role),
			["user", "assistant"]
		);
		assert.ok(!compacted.some(message => message.role === "tool"));
	});

	test("balances original tasks with recent tool activity in long summaries", () => {
		const messages: OpenAIChatMessage[] = [{ role: "system", content: "Stable system prompt" }];
		for (let index = 0; index < 40; index += 1) {
			messages.push(
				{ role: "user", content: `task ${index}` },
				{
					role: "assistant",
					tool_calls: [{
						id: `call-${index}`,
						type: "function",
						function: { name: "read_file", arguments: JSON.stringify({ filePath: `src/file-${index}.ts` }) },
					}],
				},
				{
					role: "tool",
					name: "read_file",
					tool_call_id: `call-${index}`,
					content: JSON.stringify({ filePath: `src/file-${index}.ts`, status: "ok" }),
				}
			);
		}
		messages.push({ role: "user", content: "current task" }, { role: "assistant", content: "current answer" });

		const compacted = compactMessages(messages, {
			tokenBudget: 20_000,
			keepLastCount: 2,
			label: "Summary",
			estimateTokens: () => 100,
		});
		const summary = String(compacted[1].content);
		assert.match(summary, /task 0/);
		assert.match(summary, /src\/file-39\.ts/);
		assert.ok(summary.split("\n").length <= 33);
	});
});
