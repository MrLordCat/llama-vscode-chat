import * as assert from "assert";
import * as vscode from "vscode";
import { LlamaCppChatModelProvider } from "../llama-provider";
import { convertMessages, convertTools, validateRequest } from "../utils";

// Mock SecretStorage
class MockSecretStorage implements vscode.SecretStorage {
    private secrets = new Map<string, string>();
    get(key: string): Thenable<string | undefined> {
        return Promise.resolve(this.secrets.get(key));
    }
    store(key: string, value: string): Thenable<void> {
        this.secrets.set(key, value);
        return Promise.resolve();
    }
    delete(key: string): Thenable<void> {
        this.secrets.delete(key);
        return Promise.resolve();
    }
    keys(): Thenable<string[]> {
        return Promise.resolve(Array.from(this.secrets.keys()));
    }
    onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;
}

suite("Llama.cpp Chat Provider Extension", () => {
    suite("provider", () => {
        const secretStorage = new MockSecretStorage();
        const provider = new LlamaCppChatModelProvider(secretStorage, "test-user-agent");

        test("provideLanguageModelChatInformation returns array (defaults)", async () => {
            const infos = await provider.provideLanguageModelChatInformation(
                { silent: true },
                new vscode.CancellationTokenSource().token
            );
            // It might fail if no server running, but it returns array (empty or populated)
            assert.ok(Array.isArray(infos));
        });

        test("provideTokenCount calculation for text", async () => {
            const count = await provider.provideTokenCount(
                {} as any,
                "hello world",
                new vscode.CancellationTokenSource().token
            );
            assert.strictEqual(count, 3); // "hello world".length / 4 ceil = 11/4 = 2.75 -> 3
        });

        test("provideTokenCount estimates tool and data parts", async () => {
            const message = {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }),
                    new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("file content")]),
                    vscode.LanguageModelDataPart.text("structured payload", "text/plain"),
                ],
            } as unknown as vscode.LanguageModelChatRequestMessage;

            const count = await provider.provideTokenCount(
                {} as any,
                message,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(count > 0);
        });

        test("compact summary redacts verbose tool payloads", () => {
            const providerAny = provider as unknown as {
                compactOpenAiMessages: (
                    messages: Array<{
                        role: "system" | "user" | "assistant" | "tool";
                        content?: string;
                        name?: string;
                        tool_calls?: Array<{ function?: { name?: string } }>;
                    }>,
                    tokenBudget: number,
                    keepLastCount: number,
                    label: string
                ) => Array<{ role: string; content?: string }>;
            };

            const longToolPayload = "tool-payload-very-long-1234567890".repeat(40);
            const compacted = providerAny.compactOpenAiMessages(
                [
                    { role: "system", content: "sys" },
                    { role: "user", content: "start" },
                    {
                        role: "assistant",
                        tool_calls: [{ function: { name: "read_file" } }],
                    },
                    {
                        role: "tool",
                        name: "read_file",
                        content: longToolPayload,
                    },
                    { role: "user", content: "latest" },
                ],
                10000,
                1,
                "Conversation summary (auto-compact)"
            );

            const summary = compacted.find(msg => msg.role === "system" && typeof msg.content === "string" && msg.content.includes("Conversation summary"));
            assert.ok(summary && typeof summary.content === "string");
            assert.ok(summary!.content!.includes("[tool_result read_file]"));
            assert.ok(summary!.content!.includes("[tool_calls] read_file"));
            assert.ok(!summary!.content!.includes(longToolPayload.slice(0, 80)));
        });

        test("truncates oversized tool results", () => {
            const providerAny = provider as unknown as {
                truncateToolResultMessages: (
                    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content?: string }>,
                    maxChars: number,
                    requestId: string
                ) => Array<{ role: string; content?: string }>;
            };

            const longToolPayload = "tool-output-".repeat(200);
            const truncated = providerAny.truncateToolResultMessages(
                [{ role: "tool", content: longToolPayload }],
                120,
                "test-request"
            );

            assert.ok(typeof truncated[0].content === "string");
            assert.ok(truncated[0].content!.length < longToolPayload.length);
            assert.ok(truncated[0].content!.includes("tool result truncated"));
        });

        test("serializes local chat request slots", async () => {
            const providerAny = provider as unknown as {
                acquireChatRequestSlot: (
                    requestId: string,
                    queueTimeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<{ release: () => void; waitMs: number }>;
            };
            const token = new vscode.CancellationTokenSource().token;
            const firstLease = await providerAny.acquireChatRequestSlot("first", 0, token);
            let secondAcquired = false;
            const secondSlot = providerAny.acquireChatRequestSlot("second", 0, token).then(lease => {
                secondAcquired = true;
                return lease;
            });

            await Promise.resolve();
            assert.strictEqual(secondAcquired, false);

            firstLease.release();
            const secondLease = await secondSlot;
            assert.strictEqual(secondAcquired, true);
            secondLease.release();
        });

        test("streams <think> blocks as thinking and keeps final visible answer", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"content\":\"<think>reasoning path</think>final answer\"}}]}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const text = parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value)
                .join("");
            const hasThinkingPart = parts.some(part => (part as { constructor?: { name?: string } }).constructor?.name === "LanguageModelThinkingPart");
            const hasNonTextPart = parts.some(part => !(part instanceof vscode.LanguageModelTextPart));

            assert.ok(text.includes("final answer"));
            assert.ok(!text.includes("<think>"));
            assert.ok(hasThinkingPart || hasNonTextPart || text.includes("reasoning path"));
        });

        test("streams reasoning_content deltas as thinking when available", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"step 1 -> step 2\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const text = parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value)
                .join("");
            const hasThinkingPart = parts.some(part => (part as { constructor?: { name?: string } }).constructor?.name === "LanguageModelThinkingPart");
            const hasNonTextPart = parts.some(part => !(part instanceof vscode.LanguageModelTextPart));

            assert.ok(text.includes("done"));
            assert.ok(hasThinkingPart || hasNonTextPart || text.includes("step 1 -> step 2"));
        });

        test("flushes buffered tool calls when stream ends without DONE", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]}}]}\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const toolCalls = parts.filter(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );

            assert.strictEqual(toolCalls.length, 1);
            assert.strictEqual(toolCalls[0].name, "read_file");
            assert.deepStrictEqual(toolCalls[0].input, { path: "README.md" });
        });

        test("processes final SSE line without trailing newline", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_tail\",\"function\":{\"name\":\"list_dir\",\"arguments\":\"{\\\"path\\\":\\\"src\\\"}\"}}]}}]}"
                        )
                    );
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const toolCalls = parts.filter(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );

            assert.strictEqual(toolCalls.length, 1);
            assert.strictEqual(toolCalls[0].name, "list_dir");
            assert.deepStrictEqual(toolCalls[0].input, { path: "src" });
        });

        test("flushes multiple buffered tool calls at stream end", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"grep_search\",\"arguments\":\"{\\\"query\\\":\\\"abc\\\"}\"}},{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"list_dir\",\"arguments\":\"{\\\"path\\\":\\\"src\\\"}\"}}]}}]}";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const toolCalls = parts.filter(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );

            assert.strictEqual(toolCalls.length, 2);
            assert.deepStrictEqual(
                toolCalls.map(call => ({ name: call.name, input: call.input })),
                [
                    { name: "grep_search", input: { query: "abc" } },
                    { name: "list_dir", input: { path: "src" } },
                ]
            );
        });

        test("auto-retries continuation when model returns empty output", async () => {
            const providerAny = provider as unknown as {
                getServerUrl: () => Promise<string>;
                getApiKey: () => Promise<string | undefined>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
                acquireChatRequestSlot: (
                    requestId: string,
                    queueTimeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<{ release: () => void; waitMs: number }>;
                sendChatCompletion: (
                    serverUrl: string,
                    headers: Record<string, string>,
                    requestBody: Record<string, unknown>,
                    timeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<Response>;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const originalGetServerUrl = providerAny.getServerUrl;
            const originalGetApiKey = providerAny.getApiKey;
            const originalGetRuntimeContextLengthWithCache = providerAny.getRuntimeContextLengthWithCache;
            const originalAcquireChatRequestSlot = providerAny.acquireChatRequestSlot;
            const originalSendChatCompletion = providerAny.sendChatCompletion;
            const originalProcessStreamingResponse = providerAny.processStreamingResponse;

            const sentRequestBodies: Array<Record<string, unknown>> = [];
            const reportedParts: vscode.LanguageModelResponsePart[] = [];
            let streamInvocation = 0;

            const emptyResponse = () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.close();
                        },
                    }),
                    { status: 200 }
                );

            try {
                providerAny.getServerUrl = async () => "http://localhost:8000";
                providerAny.getApiKey = async () => undefined;
                providerAny.getRuntimeContextLengthWithCache = async () => 65536;
                providerAny.acquireChatRequestSlot = async () => ({ release: () => undefined, waitMs: 0 });
                providerAny.sendChatCompletion = async (
                    _serverUrl,
                    _headers,
                    requestBody,
                    _timeoutMs,
                    _token
                ) => {
                    sentRequestBodies.push(JSON.parse(JSON.stringify(requestBody)) as Record<string, unknown>);
                    return emptyResponse();
                };
                providerAny.processStreamingResponse = async (_responseBody, progress, _token) => {
                    streamInvocation += 1;
                    if (streamInvocation === 2) {
                        progress.report(new vscode.LanguageModelTextPart("Recovered response"));
                    }
                };

                await provider.provideLanguageModelChatResponse(
                    {
                        id: "test-model",
                        name: "test-model",
                        family: "llama",
                        version: "1",
                        maxInputTokens: 32768,
                        maxOutputTokens: 4096,
                        capabilities: {},
                    } as unknown as vscode.LanguageModelChatInformation,
                    [vscode.LanguageModelChatMessage.User("Explain this")],
                    {
                        modelOptions: {},
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                    },
                    {
                        report: part => reportedParts.push(part),
                    },
                    new vscode.CancellationTokenSource().token
                );
            } finally {
                providerAny.getServerUrl = originalGetServerUrl;
                providerAny.getApiKey = originalGetApiKey;
                providerAny.getRuntimeContextLengthWithCache = originalGetRuntimeContextLengthWithCache;
                providerAny.acquireChatRequestSlot = originalAcquireChatRequestSlot;
                providerAny.sendChatCompletion = originalSendChatCompletion;
                providerAny.processStreamingResponse = originalProcessStreamingResponse;
            }

            assert.strictEqual(sentRequestBodies.length, 2, "expected one auto-retry request");

            const secondMessages = sentRequestBodies[1].messages as Array<{ role?: string; content?: string }>;
            const lastMessage = secondMessages[secondMessages.length - 1];
            assert.strictEqual(lastMessage.role, "user");
            assert.ok(
                (lastMessage.content ?? "").includes("Continue from your previous response"),
                "expected continuation prompt to be appended"
            );

            const textParts = reportedParts.filter(
                (part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart
            );
            assert.strictEqual(textParts.length, 1);
            assert.strictEqual(textParts[0].value, "Recovered response");
        });
    });

    suite("utils/convertMessages", () => {
        test("maps user/assistant text", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("hi")],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelTextPart("hello")],
                    name: undefined,
                },
            ];
            const out: any[] = convertMessages(messages);
            assert.deepEqual(out, [
                { role: "user", content: "hi" },
                { role: "assistant", content: "hello" },
            ]);
        });

        test("merges consecutive user messages", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("context")],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("query")],
                    name: undefined,
                },
            ];
            const out: any[] = convertMessages(messages);
            // Expectation: merged into one message
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].role, "user");
            assert.ok(out[0].content.includes("context"));
            assert.ok(out[0].content.includes("query"));
        });

        test("merges consecutive assistant messages (text + tool call)", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelTextPart("thinking...")],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart("call1", "my_tool", { a: 1 })],
                    name: undefined,
                },
            ];
            const out: any[] = convertMessages(messages);
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[0].content, "thinking...");
            assert.ok(out[0].tool_calls && out[0].tool_calls.length === 1);
            assert.strictEqual(out[0].tool_calls[0].function.name, "my_tool");
        });


        test("merges consecutive tool messages", () => {
             const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart("id1", [new vscode.LanguageModelTextPart("res1")])],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart("id2", [new vscode.LanguageModelTextPart("res2")])],
                    name: undefined,
                },
            ];
            const out: any[] = convertMessages(messages);
            // Expectation: merged into single User message with combined text
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].role, "user");
            assert.ok(out[0].content.includes("res1"));
            assert.ok(out[0].content.includes("res2"));
        });
        test("merges user (text) into tool message", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
               {
                   role: vscode.LanguageModelChatMessageRole.User,
                   content: [new vscode.LanguageModelTextPart("context")],
                   name: undefined,
               },
               {
                   role: vscode.LanguageModelChatMessageRole.User,
                   content: [new vscode.LanguageModelToolResultPart("id1", [new vscode.LanguageModelTextPart("res1")])],
                   name: undefined,
               },
           ];
           const out: any[] = convertMessages(messages);
           assert.strictEqual(out.length, 1);
           assert.strictEqual(out[0].role, "user");
           assert.ok(out[0].content.includes("context"));
           assert.ok(out[0].content.includes("res1"));
       });

       test("merges tool message and user (text)", () => {
           const messages: vscode.LanguageModelChatMessage[] = [
              {
                  role: vscode.LanguageModelChatMessageRole.User,
                  content: [new vscode.LanguageModelToolResultPart("id1", [new vscode.LanguageModelTextPart("res1")])],
                  name: undefined,
              },
              {
                  role: vscode.LanguageModelChatMessageRole.User,
                  content: [new vscode.LanguageModelTextPart("followup")],
                  name: undefined,
              },
          ];
          const out: any[] = convertMessages(messages);
          assert.strictEqual(out.length, 1);
          assert.strictEqual(out[0].role, "user");
          assert.ok(out[0].content.includes("res1"));
          assert.ok(out[0].content.includes("followup"));
      });

          test("keeps tool role when toolResultMode is tool", () => {
            const callId = "call_tool_1";
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart(callId, "my_tool", { q: 1 })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")])],
                    name: undefined,
                },
            ];

            const out: any[] = convertMessages(messages, { toolResultMode: "tool" });
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[1].role, "tool");
            assert.strictEqual(out[1].tool_call_id, callId);
            assert.ok((out[1].content as string).includes("ok"));
          });

      test("hoists system messages to the top", () => {
          const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("user1")],
                    name: undefined,
                },
                // System message in the middle (e.g. injected context)
                {
                    role: 0 as any, // "System" isn't in the enum but mapRole handles strict check or fallback?
                    // Wait, mapRole default is System. Let's force it via a mock or just assume default is used if not User/Assistant.
                    // Actually, LanguageModelChatMessageRole has User(1) and Assistant(2). 0 or other might be System?
                    // VS Code doesn't expose System role directly in the enum usually, but Copilot sends it?
                    // Let's use a cast to simulate "System" if the enum doesn't have it, or rely on mapRole fallback.
                    // mapRole implementation: if r===USER return user, if r===ASSISTANT return assistant, else return system.
                    // So passing specific unrelated number works.
                } as vscode.LanguageModelChatMessage, // Trick to pass invalid role?
          ];

          // Actually, let's just make a cleaner test with manual objects if the type allows
          // The type is 'readonly vscode.LanguageModelChatMessage[]'.
          const sysMsg = { role: 3, content: [new vscode.LanguageModelTextPart("sys instruction")] } as unknown as vscode.LanguageModelChatMessage;
          const userMsg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart("hi")] } as vscode.LanguageModelChatMessage;

          const msgs = [userMsg, sysMsg];
          const out: any[] = convertMessages(msgs);

          // Expect: [System, User]
          assert.strictEqual(out.length, 2);
          assert.strictEqual(out[0].role, "system");
          assert.strictEqual(out[0].content, "sys instruction");
          assert.strictEqual(out[1].role, "user");
          assert.strictEqual(out[1].content, "hi");
      });


    });

    suite("utils/tools", () => {
        test("convertTools returns function tool definitions", () => {
			const out = convertTools({
				tools: [
					{
						name: "do_something",
						description: "Does something",
						inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);

			assert.ok(out);
			assert.equal(out.tool_choice, "auto");
			assert.ok(Array.isArray(out.tools) && out.tools[0].type === "function");
			assert.equal(out.tools[0].function.name, "do_something");
		});

		test("convertTools respects ToolMode.Required for single tool", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [
					{
						name: "only_tool",
						description: "Only tool",
						inputSchema: {},
					},
				],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
		});

        test("convertTools suppresses run_vscode_command when run_in_terminal exists", () => {
            const out = convertTools({
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                tools: [
                    {
                        name: "run_vscode_command",
                        description: "Run a VS Code command",
                        inputSchema: { type: "object", properties: {} },
                    },
                    {
                        name: "run_in_terminal",
                        description: "Run a terminal command",
                        inputSchema: { type: "object", properties: {} },
                    },
                ],
            } satisfies vscode.ProvideLanguageModelChatResponseOptions);

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.ok(names.includes("run_in_terminal"));
            assert.ok(!names.includes("run_vscode_command"));
        });

        test("convertTools keeps run_vscode_command in required mode", () => {
            const out = convertTools({
                toolMode: vscode.LanguageModelChatToolMode.Required,
                tools: [
                    {
                        name: "run_vscode_command",
                        description: "Run a VS Code command",
                        inputSchema: { type: "object", properties: {} },
                    },
                ],
            } satisfies vscode.ProvideLanguageModelChatResponseOptions);

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.deepEqual(names, ["run_vscode_command"]);
            assert.deepEqual(out.tool_choice, { type: "function", function: { name: "run_vscode_command" } });
        });
    });

    suite("utils/validation", () => {
        test("validateRequest enforces tool result pairing", () => {
            const callId = "xyz";
            const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
            const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
            const valid = [
                { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
                { role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
            ];
            assert.doesNotThrow(() => validateRequest(valid));

            const invalid = [
                { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
                { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart("missing")], name: undefined },
            ];
            assert.throws(() => validateRequest(invalid));
        });
    });
});
