import * as assert from "assert";
import * as vscode from "vscode";

import { CodexAppServerClient, JsonLineBuffer, type CodexServerNotification } from "../codex/app-server-client";
import { CompositeChatModelProvider } from "../composite-provider";
import { CodexChatModelProvider } from "../codex/codex-provider";
import { buildCodexDynamicTools, CODEX_DEFERRED_TOOL_NAMESPACE } from "../codex/dynamic-tools";
import {
	createCodexConversationAnchor,
	convertCodexToolResult,
	findCodexConversationTail,
	findCodexToolContinuation,
	findCodexToolContinuations,
	serializeCodexConversation,
} from "../codex/message-adapter";
import {
	createCodexReasoningConfigurationSchema,
	formatCodexRateLimit,
	mapCodexModelInformation,
	resolveCodexReasoningEffort,
} from "../codex/model-adapter";
import type { CodexModel } from "../codex/protocol";
import { CodexTurnBridge } from "../codex/turn-bridge";

const model: CodexModel = {
	id: "gpt-test",
	model: "gpt-test",
	displayName: "GPT Test",
	description: "Test Codex model",
	hidden: false,
	supportedReasoningEfforts: [
		{ reasoningEffort: "low", description: "Fast" },
		{ reasoningEffort: "high", description: "Deep" },
	],
	defaultReasoningEffort: "low",
	inputModalities: ["text", "image"],
	isDefault: true,
};

suite("Codex subscription provider", () => {
	test("buffers split JSONL process chunks", () => {
		const buffer = new JsonLineBuffer();
		assert.deepStrictEqual(buffer.push('{"id":1'), []);
		assert.deepStrictEqual(buffer.push('}\r\n{"method":"ready"}\npartial'), [
			'{"id":1}',
			'{"method":"ready"}',
		]);
		assert.deepStrictEqual(buffer.push(" line\n"), ["partial line"]);
	});

	test("drops an incomplete JSONL fragment when the app-server generation changes", () => {
		const buffer = new JsonLineBuffer();
		assert.deepStrictEqual(buffer.push('{"old":'), []);
		buffer.reset();
		assert.deepStrictEqual(buffer.push('{"fresh":true}\n'), ['{"fresh":true}']);
	});

	test("invalidates process generation as soon as the app-server stops", () => {
		const client = new CodexAppServerClient("test");
		const internals = client as unknown as {
			process: { killed: boolean; kill: () => boolean };
			stopProcess: (error: Error) => void;
		};
		internals.process = {
			killed: false,
			kill: () => true,
		};
		const generation = client.generation;
		internals.stopProcess(new Error("test stop"));
		assert.strictEqual(client.generation, generation + 1);
		client.dispose();
	});

	test("advertises model reasoning options and context", () => {
		const info = mapCodexModelInformation(model, 258_400, 32_768) as vscode.LanguageModelChatInformation & Record<string, unknown>;
		assert.strictEqual(info.id, "codex::gpt-test");
		assert.strictEqual(info.name, "GPT Test (Codex)");
		assert.strictEqual(info.maxInputTokens, 225_632);
		assert.strictEqual(info.maxOutputTokens, 32_768);
		assert.strictEqual(info.capabilities.imageInput, true);
		assert.strictEqual(info.capabilities.toolCalling, true);

		const schema = createCodexReasoningConfigurationSchema(model);
		assert.deepStrictEqual(schema.properties.reasoningEffort.enum, ["low", "high"]);
		assert.strictEqual(schema.properties.reasoningEffort.default, "low");
	});

	test("uses native effort when supported and falls back to catalog default", () => {
		assert.strictEqual(resolveCodexReasoningEffort("auto", "high", model), "high");
		assert.strictEqual(resolveCodexReasoningEffort("high", undefined, model), "high");
		assert.strictEqual(resolveCodexReasoningEffort("ultra", undefined, model), "low");
	});

	test("serializes VS Code text and tool history as conversation data", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("Inspect the repository"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("# Project")]),
			]),
		];
		const input = serializeCodexConversation(messages);
		assert.ok(input.text.includes("Inspect the repository"));
		assert.ok(input.text.includes("VS Code tool call: read_file"));
		assert.ok(input.text.includes("# Project"));
		assert.deepStrictEqual(input.images, []);
		assert.strictEqual(input.omittedMessageCount, 0);
		assert.strictEqual(input.truncatedMessageCount, 0);
	});

	test("bounds oversized histories while preserving the first and latest requests", () => {
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			vscode.LanguageModelChatMessage.User("FIRST-MESSAGE-MARKER"),
		];
		for (let index = 0; index < 8; index++) {
			messages.push(vscode.LanguageModelChatMessage.Assistant(
				`OLD-HISTORY-${index}\n${"x".repeat(40_000)}`
			));
		}
		messages.push(vscode.LanguageModelChatMessage.User(
			`LATEST-REQUEST-MARKER\n${"z".repeat(20_000)}\nLATEST-REQUEST-TAIL`
		));

		const input = serializeCodexConversation(messages, { maxTextChars: 12_000 });
		assert.ok(input.text.length <= 12_000, `serialized input was ${input.text.length} characters`);
		assert.ok(input.text.includes("FIRST-MESSAGE-MARKER"));
		assert.ok(input.text.includes("LATEST-REQUEST-MARKER"));
		assert.ok(input.text.includes("LATEST-REQUEST-TAIL"));
		assert.ok(input.text.includes("Earlier VS Code conversation messages were omitted"));
		assert.strictEqual(input.originalMessageCount, messages.length);
		assert.strictEqual(input.includedMessageCount, 2);
		assert.strictEqual(input.omittedMessageCount, messages.length - 2);
		assert.strictEqual(input.truncatedMessageCount, 1);
		assert.ok(input.originalTextChars > 300_000);
	});

	test("does not resend images from conversation messages omitted by the text budget", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("first"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelTextPart("old\n" + "x".repeat(20_000)),
				vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png") as unknown as vscode.LanguageModelTextPart,
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelTextPart("latest"),
				vscode.LanguageModelDataPart.image(new Uint8Array([4, 5, 6]), "image/png") as unknown as vscode.LanguageModelTextPart,
			]),
		];
		const input = serializeCodexConversation(messages, { maxTextChars: 4_096 });
		assert.strictEqual(input.omittedMessageCount, 1);
		assert.strictEqual(input.originalImageCount, 2);
		assert.strictEqual(input.omittedImageCount, 1);
		assert.strictEqual(input.images.length, 1);
		assert.ok(input.images[0].endsWith("BAUG"));
	});

	test("truncates historical tool results before dropping conversation messages", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("FIRST"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("large-call", "read_file", { path: "large.log" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("large-call", [
					new vscode.LanguageModelTextPart(`HEAD\n${"x".repeat(50_000)}\nTAIL`),
				]),
			]),
			vscode.LanguageModelChatMessage.User("LATEST"),
		];
		const input = serializeCodexConversation(messages, {
			maxTextChars: 20_000,
			maxToolResultChars: 2_048,
		});
		assert.strictEqual(input.includedMessageCount, messages.length);
		assert.strictEqual(input.omittedMessageCount, 0);
		assert.strictEqual(input.truncatedToolResultCount, 1);
		assert.ok(input.text.includes("tool result characters omitted"));
		assert.ok(input.text.includes("HEAD"));
		assert.ok(input.text.includes("TAIL"));
		assert.ok(input.text.includes("LATEST"));
	});

	test("selects only the native tool-result tail when resuming a Codex thread", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User(`large history\n${"x".repeat(100_000)}`),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("pending-call", "read_file", { path: "README.md" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("pending-call", [new vscode.LanguageModelTextPart("result")]),
			]),
		];
		const continuation = findCodexToolContinuation(messages, new Set(["pending-call"]));
		assert.ok(continuation);
		assert.strictEqual(continuation.callId, "pending-call");
		assert.strictEqual(continuation.messages.length, 1);
		const input = serializeCodexConversation(continuation.messages);
		assert.ok(input.text.includes("result"));
		assert.ok(input.text.length < 2_000);
		assert.ok(!input.text.includes("large history"));
	});

	test("keeps one app-server turn alive across a native tool card", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		let turnStarts = 0;
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => {
				if (method === "turn/start") {
					turnStarts++;
					return { turn: { id: "turn-1", status: "inProgress" } };
				}
				return {};
			},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-1");
		const firstParts: vscode.LanguageModelResponsePart[] = [];
		const secondParts: vscode.LanguageModelResponsePart[] = [];
		const tokenSource = new vscode.CancellationTokenSource();
		const firstBoundaryPromise = bridge.start(
			{ threadId: "thread-1", input: [] },
			{ report: part => firstParts.push(part) },
			tokenSource.token
		);
		notifications.fire({
			method: "item/agentMessage/delta",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "preface", delta: "pre" },
		});
		const dynamicResponsePromise = bridge.delegate({
			callId: "call-1",
			tool: "read_file",
			input: { path: "README.md" },
			turnId: "turn-1",
		});
		const firstBoundary = await firstBoundaryPromise;
		assert.strictEqual(firstBoundary.kind, "delegated");
		assert.ok(firstParts.some(part => part instanceof vscode.LanguageModelToolCallPart));

		const toolResponse = { contentItems: [{ type: "inputText" as const, text: "file contents" }], success: true };
		const resumed = bridge.resume(new Map([["call-1", toolResponse]]), { report: part => secondParts.push(part) }, tokenSource.token);
		assert.deepStrictEqual(await dynamicResponsePromise, toolResponse);
		notifications.fire({
			method: "item/agentMessage/delta",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: "done" },
		});
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
		});
		assert.strictEqual((await resumed).kind, "completed");
		assert.strictEqual(turnStarts, 1);
		assert.ok(secondParts.some(part => part instanceof vscode.LanguageModelTextPart));
		assert.strictEqual(bridge.finalText, "predone");
		assert.strictEqual(bridge.segmentText, "done");
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("batches parallel dynamic tool calls into one resumed app-server turn", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => method === "turn/start"
				? { turn: { id: "turn-batch", status: "inProgress" } }
				: {},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-batch");
		const parts: vscode.LanguageModelResponsePart[] = [];
		const tokenSource = new vscode.CancellationTokenSource();
		const boundaryPromise = bridge.start(
			{ threadId: "thread-batch", input: [] },
			{ report: part => parts.push(part) },
			tokenSource.token
		);
		const firstResponse = bridge.delegate({ callId: "call-a", tool: "read_file", input: { path: "a" } });
		const secondResponse = bridge.delegate({ callId: "call-b", tool: "read_file", input: { path: "b" } });
		assert.strictEqual((await boundaryPromise).kind, "delegated");
		assert.deepStrictEqual(bridge.pendingCalls.map(call => call.callId), ["call-a", "call-b"]);
		assert.strictEqual(parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length, 2);

		const resumePromise = bridge.resume(new Map([
			["call-a", { contentItems: [{ type: "inputText" as const, text: "A" }], success: true }],
			["call-b", { contentItems: [{ type: "inputText" as const, text: "B" }], success: true }],
		]), { report: () => undefined }, tokenSource.token);
		assert.strictEqual((await firstResponse).contentItems[0].type, "inputText");
		assert.strictEqual((await secondResponse).contentItems[0].type, "inputText");
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-batch", turn: { id: "turn-batch", status: "completed", error: null } },
		});
		assert.strictEqual((await resumePromise).kind, "completed");
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("rejects an incomplete parallel tool-result batch without resuming the turn", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async () => ({ turn: { id: "turn-incomplete", status: "inProgress" } }),
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-incomplete");
		const tokenSource = new vscode.CancellationTokenSource();
		const boundaryPromise = bridge.start(
			{ threadId: "thread-incomplete", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		void bridge.delegate({ callId: "call-a", tool: "read_file", input: { path: "a" } });
		void bridge.delegate({ callId: "call-b", tool: "read_file", input: { path: "b" } });
		await boundaryPromise;

		await assert.rejects(
			bridge.resume(new Map([
				["call-a", { contentItems: [{ type: "inputText", text: "A" }], success: true }],
			]), { report: () => undefined }, tokenSource.token),
			/missing call ids: call-b/
		);
		assert.strictEqual(bridge.pendingCalls.length, 2);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("releases a suspended native tool call when the app-server stops", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async () => ({ turn: { id: "turn-stop", status: "inProgress" } }),
		} as unknown as CodexAppServerClient;
		let stopCallbacks = 0;
		const bridge = new CodexTurnBridge(fakeClient, "thread-stop", undefined, () => stopCallbacks++);
		const tokenSource = new vscode.CancellationTokenSource();
		const boundaryPromise = bridge.start(
			{ threadId: "thread-stop", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		const toolResponse = bridge.delegate({ callId: "call-stop", tool: "read_file", input: { path: "a" } });
		const stopped = new Error("app-server stopped for test");
		stops.fire(stopped);

		await assert.rejects(boundaryPromise, /stopped for test/);
		assert.strictEqual((await toolResponse).success, false);
		assert.strictEqual(stopCallbacks, 1);
		assert.strictEqual(bridge.pendingCalls.length, 0);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("finds every pending native tool result in one Copilot round", () => {
		const messages = [vscode.LanguageModelChatMessage.User([
			new vscode.LanguageModelToolResultPart("call-a", [new vscode.LanguageModelTextPart("A")]),
			new vscode.LanguageModelToolResultPart("call-b", [new vscode.LanguageModelTextPart("B")]),
		])];
		const matches = findCodexToolContinuations(messages, new Set(["call-a", "call-b"]));
		assert.deepStrictEqual(new Set(matches.map(match => match.callId)), new Set(["call-a", "call-b"]));
	});

	test("bounds native tool output before returning it to the active Codex turn", () => {
		const result = new vscode.LanguageModelToolResultPart("call", [
			new vscode.LanguageModelTextPart(`HEAD\n${"x".repeat(20_000)}\nTAIL`),
		]);
		const converted = convertCodexToolResult(result, 2_048);
		assert.strictEqual(converted.success, true);
		const textItem = converted.contentItems.find(item => item.type === "inputText");
		assert.ok(textItem && textItem.text.length <= 2_048);
		assert.ok(textItem?.text.includes("HEAD"));
		assert.ok(textItem?.text.includes("TAIL"));
	});

	test("reuses a completed Codex conversation only for an unchanged history", () => {
		const original = [vscode.LanguageModelChatMessage.User("original request")];
		const anchor = createCodexConversationAnchor(original, "completed answer");
		const nextTurn = [
			...original,
			vscode.LanguageModelChatMessage.Assistant("completed answer"),
			vscode.LanguageModelChatMessage.User("follow-up request"),
		];
		const tail = findCodexConversationTail(nextTurn, anchor);
		assert.ok(tail);
		assert.strictEqual(tail.length, 1);
		assert.strictEqual((tail[0].content[0] as vscode.LanguageModelTextPart).value, "follow-up request");

		const edited = [
			vscode.LanguageModelChatMessage.User("edited original request"),
			vscode.LanguageModelChatMessage.Assistant("completed answer"),
			vscode.LanguageModelChatMessage.User("follow-up request"),
		];
		assert.strictEqual(findCodexConversationTail(edited, anchor), undefined);
	});

	test("does not reuse a conversation when the prior assistant answer differs", () => {
		const original = [vscode.LanguageModelChatMessage.User("request")];
		const anchor = createCodexConversationAnchor(original, "expected answer");
		const regenerated = [
			...original,
			vscode.LanguageModelChatMessage.Assistant("different answer"),
			vscode.LanguageModelChatMessage.User("follow-up"),
		];
		assert.strictEqual(findCodexConversationTail(regenerated, anchor), undefined);
	});

	test("advertises public and private outer tools for native Copilot delegation", () => {
		const tools: vscode.LanguageModelChatTool[] = [
			{ name: "copilot_readFile", description: "Read a workspace file", inputSchema: { type: "object" } },
			{ name: "private_tool", description: "Private caller tool", inputSchema: { type: "object" } },
		];
		const dynamic = buildCodexDynamicTools(tools);
		assert.deepStrictEqual(dynamic.specs.map(tool => tool.name), ["copilot_readFile", "private_tool"]);
		assert.deepStrictEqual(dynamic.skippedNames, []);
		assert.ok(dynamic.callableNames.has("private_tool"));
	});

	test("defers uncommon Codex tools while keeping the core agent loop eager", () => {
		const tools: vscode.LanguageModelChatTool[] = [
			{ name: "read_file", description: "Read a workspace file", inputSchema: { type: "object" } },
			{ name: "run_in_terminal", description: "Run a command", inputSchema: { type: "object" } },
			{ name: "llamacpp_search_memory", description: "Search memory", inputSchema: { type: "object" } },
			{ name: "specialized_private_tool", description: "Rare tool", inputSchema: { type: "object" } },
		];
		const dynamic = buildCodexDynamicTools(tools, { deferNonCoreTools: true });
		const eagerNames = dynamic.specs
			.filter(tool => tool.type === "function")
			.map(tool => tool.name);
		const namespace = dynamic.specs.find(tool => tool.type === "namespace");
		assert.deepStrictEqual(eagerNames, ["read_file", "run_in_terminal"]);
		assert.ok(namespace && namespace.type === "namespace");
		assert.strictEqual(namespace.name, CODEX_DEFERRED_TOOL_NAMESPACE);
		assert.deepStrictEqual(namespace.tools.map(tool => tool.name), ["llamacpp_search_memory", "specialized_private_tool"]);
		assert.ok(namespace.tools.every(tool => tool.deferLoading === true));
		assert.deepStrictEqual(dynamic.deferredNames, new Set(["llamacpp_search_memory", "specialized_private_tool"]));
		assert.deepStrictEqual(
			dynamic.runtimeSignatures.filter(tool => tool.deferLoading).map(tool => tool.namespace),
			[CODEX_DEFERRED_TOOL_NAMESPACE, CODEX_DEFERRED_TOOL_NAMESPACE]
		);
	});

	test("routes a deferred dynamic tool only through its declared namespace", async () => {
		const provider = new CodexChatModelProvider("test");
		let delegatedTool = "";
		const internals = provider as unknown as {
			dynamicToolContexts: Map<string, {
				callableNames: ReadonlySet<string>;
				deferredNames: ReadonlySet<string>;
				delegate: (call: { tool: string }) => Promise<{ contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }>;
			}>;
			handleDynamicToolCall: (params: Record<string, unknown>) => Promise<{ success: boolean }> | { success: boolean };
		};
		internals.dynamicToolContexts.set("thread", {
			callableNames: new Set(["create_directory"]),
			deferredNames: new Set(["create_directory"]),
			delegate: async call => {
				delegatedTool = call.tool;
				return { contentItems: [{ type: "inputText", text: "ok" }], success: true };
			},
		});

		const rejected = await internals.handleDynamicToolCall({
			threadId: "thread",
			callId: "wrong-namespace",
			tool: "create_directory",
			namespace: null,
			arguments: { path: "tmp" },
		});
		assert.strictEqual(rejected.success, false);
		const accepted = await internals.handleDynamicToolCall({
			threadId: "thread",
			callId: "correct-namespace",
			tool: "create_directory",
			namespace: CODEX_DEFERRED_TOOL_NAMESPACE,
			arguments: { path: "tmp" },
		});
		assert.strictEqual(accepted.success, true);
		assert.strictEqual(delegatedTool, "create_directory");
		provider.dispose();
	});

	test("formats Codex subscription usage", () => {
		const formatted = formatCodexRateLimit({
			limitId: "codex",
			limitName: null,
			primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: null },
			secondary: null,
			planType: "plus",
			rateLimitReachedType: null,
		});
		assert.strictEqual(formatted, "12% used / resets unknown reset");
	});

	test("combines catalogs and routes prefixed Codex model ids", async () => {
		const calls: string[] = [];
		const makeProvider = (id: string, marker: string): vscode.LanguageModelChatProvider => ({
			provideLanguageModelChatInformation: async () => [{
				id,
				name: id,
				family: marker,
				version: "1",
				maxInputTokens: 100,
				maxOutputTokens: 20,
				capabilities: {},
			}],
			provideLanguageModelChatResponse: async () => {
				calls.push(marker);
			},
			provideTokenCount: async () => marker === "codex" ? 2 : 1,
		});
		const provider = new CompositeChatModelProvider(
			makeProvider("local::qwen", "local"),
			makeProvider("codex::gpt-test", "codex")
		);
		const tokenSource = new vscode.CancellationTokenSource();
		const infos = await provider.provideLanguageModelChatInformation({ silent: true }, tokenSource.token);
		assert.deepStrictEqual(infos.map(info => info.id), ["codex::gpt-test", "local::qwen"]);

		const codexInfo = infos.find(info => info.id.startsWith("codex::"));
		assert.ok(codexInfo);
		await provider.provideLanguageModelChatResponse(
			codexInfo!,
			[],
			{ tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
			{ report: () => undefined },
			tokenSource.token
		);
		assert.deepStrictEqual(calls, ["codex"]);
		assert.strictEqual(await provider.provideTokenCount(codexInfo!, "test", tokenSource.token), 2);
		provider.dispose();
		tokenSource.dispose();
	});
});
