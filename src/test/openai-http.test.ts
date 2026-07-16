import * as assert from "node:assert";
import {
	getChatCompletionsEndpoint,
	getModelsEndpoint,
	OpenAIHttpTransport,
} from "../transport/openai-http";

suite("OpenAI HTTP transport", () => {
	test("resolves local and DeepSeek endpoints", () => {
		assert.strictEqual(getChatCompletionsEndpoint("http://localhost:8000"), "http://localhost:8000/v1/chat/completions");
		assert.strictEqual(getModelsEndpoint("http://localhost:8000"), "http://localhost:8000/v1/models");
		assert.strictEqual(getChatCompletionsEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
		assert.strictEqual(getModelsEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/models");
	});

	test("posts serialized chat requests through the injected fetch implementation", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const transport = new OpenAIHttpTransport(async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return new Response(null, { status: 200 });
		});
		const cancellation = {
			isCancellationRequested: false,
			onCancellationRequested: (_listener: () => void) => ({ dispose() {} }),
		};

		await transport.postChatCompletion(
			"http://localhost:8000",
			{ "Content-Type": "application/json" },
			{ model: "qwen" },
			1000,
			cancellation
		);

		assert.strictEqual(capturedUrl, "http://localhost:8000/v1/chat/completions");
		assert.strictEqual(capturedInit?.method, "POST");
		assert.strictEqual(capturedInit?.body, JSON.stringify({ model: "qwen" }));
	});
});
