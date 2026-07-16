import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildMemoryQuery, injectSharedMemoryContext } from "../memory/prompt";
import { SharedMemoryService } from "../memory/shared-memory-service";
import type { OpenAIChatMessage } from "../types";

suite("Shared memory", () => {
	let tempDirectory = "";
	let memory: SharedMemoryService;

	setup(async () => {
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "llamacpp-memory-test-"));
		memory = new SharedMemoryService(tempDirectory);
		await memory.initialize();
	});

	teardown(async () => {
		await fs.rm(tempDirectory, { recursive: true, force: true });
	});

	test("creates, updates, searches, and deletes durable entries", async () => {
		const created = await memory.upsert({
			title: "Preferred local model",
			content: "Use Qwen for local coding tasks.",
			tags: ["Qwen", "Local"],
		});

		assert.ok(created.id.length > 0);
		assert.strictEqual(memory.count, 1);
		assert.strictEqual(memory.search("qwen coding")[0].id, created.id);

		const updated = await memory.upsert({
			id: created.id,
			title: "Preferred local model",
			content: "Use Qwen with a 131072 token context for local coding tasks.",
			pinned: true,
		});

		assert.strictEqual(updated.id, created.id);
		assert.strictEqual(memory.search("unrelated query")[0].id, created.id);
		assert.strictEqual(await memory.remove(created.id), true);
		assert.strictEqual(memory.count, 0);
	});

	test("persists entries across service instances", async () => {
		const created = await memory.upsert({
			title: "Build command",
			content: "Package the extension as a VSIX after compiling.",
		});
		const reloaded = new SharedMemoryService(tempDirectory);
		await reloaded.initialize();

		assert.strictEqual(reloaded.list().length, 1);
		assert.strictEqual(reloaded.list()[0].id, created.id);
	});

	test("keeps injected memory inside its configured budget", async () => {
		await memory.upsert({
			title: "Large entry",
			content: "context ".repeat(4000),
			pinned: true,
		});
		const context = await memory.buildPromptContext("context", 128);

		assert.ok(context);
		assert.ok(context!.estimatedTokens <= 128);
		assert.ok(context!.text.length <= 512);
	});

	test("merges shared memory into the existing system message", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Base instructions" },
			{ role: "user", content: "Work on the local provider" },
		];
		const injected = injectSharedMemoryContext(messages, "- Preferred model: Qwen");

		assert.strictEqual(injected.length, 2);
		assert.match(String(injected[0].content), /Base instructions/);
		assert.match(String(injected[0].content), /Preferred model: Qwen/);
		assert.strictEqual(messages[0].content, "Base instructions");
	});

	test("builds retrieval query from recent user messages only", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "assistant", content: "ignore assistant text" },
			{ role: "user", content: "first user topic" },
			{ role: "user", content: "latest Qwen topic" },
		];

		const query = buildMemoryQuery(messages);
		assert.match(query, /first user topic/);
		assert.match(query, /latest Qwen topic/);
		assert.doesNotMatch(query, /ignore assistant text/);
	});
});
