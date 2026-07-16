import * as assert from "node:assert";
import { ServerTokenCounter } from "../context/server-token-counter";

const cancellation = {
	isCancellationRequested: false,
	onCancellationRequested: (_listener: () => void) => ({ dispose() {} }),
};

suite("server token counter", () => {
	test("applies the server template and tokenizes the resulting prompt", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const counter = new ServerTokenCounter(async (url, init) => {
			requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
			if (url.endsWith("/apply-template")) {
				return Response.json({ prompt: "templated prompt" });
			}
			return Response.json({ tokens: [1, 2, 3, 4] });
		});

		const count = await counter.countChatPrompt({
			serverUrl: "http://localhost:8000/",
			model: "qwen",
			headers: { "Content-Type": "application/json" },
			messages: [{ role: "user", content: "hello" }],
			tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
			chatTemplateKwargs: { enable_thinking: true },
			timeoutMs: 1000,
			cancellation,
		});

		assert.strictEqual(count, 4);
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(requests[0].url, "http://localhost:8000/apply-template");
		assert.strictEqual(requests[1].url, "http://localhost:8000/tokenize");
		assert.deepStrictEqual(requests[0].body.chat_template_kwargs, { enable_thinking: true });
	});

	test("caches identical prompt counts", async () => {
		let calls = 0;
		const counter = new ServerTokenCounter(async (url) => {
			calls += 1;
			return url.endsWith("/apply-template")
				? Response.json({ prompt: "prompt" })
				: Response.json({ tokens: [1, 2] });
		});
		const input = {
			serverUrl: "http://localhost:8000",
			model: "qwen",
			headers: { "Content-Type": "application/json" },
			messages: [{ role: "user" as const, content: "hello" }],
			timeoutMs: 1000,
			cancellation,
		};

		assert.strictEqual(await counter.countChatPrompt(input), 2);
		assert.strictEqual(await counter.countChatPrompt(input), 2);
		assert.strictEqual(calls, 2);
	});

	test("falls back when the server does not expose tokenizer endpoints", async () => {
		const counter = new ServerTokenCounter(async () => new Response(null, { status: 404 }));
		const count = await counter.countChatPrompt({
			serverUrl: "http://localhost:8000",
			model: "qwen",
			headers: { "Content-Type": "application/json" },
			messages: [{ role: "user", content: "hello" }],
			timeoutMs: 1000,
			cancellation,
		});
		assert.strictEqual(count, undefined);
	});
});
