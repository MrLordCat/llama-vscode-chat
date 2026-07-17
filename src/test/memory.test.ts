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
		assert.strictEqual(memory.search("unrelated query").length, 0);
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
		assert.strictEqual(reloaded.list()[0].scope, "global");
		assert.strictEqual(reloaded.list()[0].kind, "other");
	});

	test("migrates version-one entries to global other memory", async () => {
		await fs.writeFile(memory.filePath, JSON.stringify({
			version: 1,
			entries: [{
				id: "legacy",
				title: "Legacy preference",
				content: "Use the existing build command.",
				tags: [],
				pinned: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}],
		}), "utf8");
		await memory.reload();

		assert.strictEqual(memory.list()[0].scope, "global");
		assert.strictEqual(memory.list()[0].kind, "other");
	});

	test("filters workspace, model, and expired memory during injection", async () => {
		await memory.upsert({ title: "Global", content: "Qwen global rule", scope: "global" });
		await memory.upsert({ title: "Workspace A", content: "Qwen workspace alpha", scope: "workspace", scopeId: "file:///a" });
		await memory.upsert({ title: "Workspace B", content: "Qwen workspace beta", scope: "workspace", scopeId: "file:///b" });
		await memory.upsert({ title: "Model", content: "Qwen model rule", scope: "model", scopeId: "qwen-local" });
		await memory.upsert({
			title: "Expired",
			content: "Qwen stale external fact",
			kind: "externalFact",
			sourceUrl: "https://example.com/fact",
			verifiedAt: "2025-01-01T00:00:00.000Z",
			expiresAt: "2025-02-01T00:00:00.000Z",
		});

		const context = await memory.buildPromptContext("qwen", 1024, {
			workspaceId: "file:///a",
			modelId: "qwen-local",
		});
		assert.ok(context?.text.includes("Qwen global rule"));
		assert.ok(context?.text.includes("Qwen workspace alpha"));
		assert.ok(!context?.text.includes("Qwen workspace beta"));
		assert.ok(context?.text.includes("Qwen model rule"));
		assert.ok(!context?.text.includes("Qwen stale external fact"));
		assert.strictEqual(context?.expiredEntryCount, 1);

		const modelOnly = memory.search("qwen", 1, {
			workspaceId: "file:///a",
			modelId: "qwen-local",
			scope: "model",
		});
		assert.strictEqual(modelOnly.length, 1);
		assert.strictEqual(modelOnly[0].scope, "model");
	});

	test("uses fuzzy retrieval without letting pinned unrelated entries leak in", async () => {
		await memory.upsert({ title: "TypeScript build", content: "Compile with strict TypeScript checks." });
		await memory.upsert({ title: "Unrelated", content: "Coffee preference", pinned: true });

		const results = memory.search("typescrpt compilation");
		assert.strictEqual(results[0]?.title, "TypeScript build");
		assert.ok(!results.some(entry => entry.title === "Unrelated"));
	});

	test("requires provenance for external facts", async () => {
		await assert.rejects(
			memory.upsert({ title: "API limit", content: "The API has a changing limit.", kind: "externalFact" }),
			/sourceUrl and verifiedAt/
		);
		const entry = await memory.upsert({
			title: "API limit",
			content: "The API has a changing limit.",
			kind: "externalFact",
			sourceUrl: "https://example.com/docs",
			verifiedAt: "2026-07-17T00:00:00.000Z",
		});
		assert.strictEqual(entry.kind, "externalFact");
		assert.strictEqual(entry.sourceUrl, "https://example.com/docs");
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

	test("injects shared memory near the latest user turn to preserve the cached prefix", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Base instructions" },
			{ role: "user", content: "Earlier request" },
			{ role: "assistant", content: "Earlier answer" },
			{ role: "user", content: "Work on the local provider" },
		];
		const injected = injectSharedMemoryContext(messages, "- Preferred model: Qwen");

		assert.strictEqual(injected.length, 5);
		assert.deepStrictEqual(injected.slice(0, 3), messages.slice(0, 3));
		assert.strictEqual(injected[3].role, "user");
		assert.match(String(injected[3].content), /Preferred model: Qwen/);
		assert.strictEqual(injected[4].content, "Work on the local provider");
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
