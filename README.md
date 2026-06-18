# Llama.cpp Chat Provider for VS Code

Personal fork focused on making VS Code Chat work well with OpenAI-compatible
local llama.cpp servers and the official DeepSeek API.

The extension registers a `llamacpp` language model provider for VS Code Chat,
so GitHub Copilot Chat and agent workflows can use local or remote models while
keeping tool calling, streaming responses, context budgeting, and diagnostics.

## Goals

- Use a local llama.cpp server efficiently from VS Code Chat.
- Support DeepSeek V4 Pro / Flash through the official OpenAI-compatible API.
- Keep tool calling usable for coding-agent workflows.
- Reduce prompt/tool token overhead with API Direct mode.
- Avoid long-session stalls from huge tool results, stream spam, or oversized
  request logs.
- Provide enough logging and status information to debug model/provider issues.

## Main Features

- OpenAI-compatible chat completions:
  - llama.cpp: `GET /v1/models`, `POST /v1/chat/completions`
  - DeepSeek: `GET /models`, `POST /chat/completions`
- Streaming text responses with chunk coalescing to reduce VS Code UI stalls.
- Tool calling with OpenAI `tools` and `tool` result messages.
- API Direct tool mode for compact tool schemas and prioritized tool selection.
- DeepSeek thinking-mode support:
  - `thinking.type`
  - `reasoning_effort`
  - streamed `reasoning_content`
  - preservation of `reasoning_content` for assistant tool-call turns
- Context budgeting, auto-compaction, and context-overflow retry.
- Large tool-result truncation or summarization.
- Tool-result artifact sanitization for transient metadata blobs.
- Request queueing for single-slot local llama.cpp generation.
- Optional JSONL file logging.
- Status bar metrics for throughput and context usage.
- Quick Access sidebar commands for configuration and diagnostics.

## Quick Start: Local llama.cpp

Start llama.cpp with an OpenAI-compatible server, for example:

```sh
llama-server -m path/to/model.gguf --host 127.0.0.1 --port 8000 --ctx-size 65536
```

Then in VS Code:

1. Run `Llama.cpp: Open Sidebar`.
2. Run `Manage Llama.cpp Provider`.
3. Set server URL, for example `http://localhost:8000`.
4. Run `Llama.cpp: Refresh Models`.
5. Open the chat model picker and select a `llamacpp` model.

Recommended local defaults:

```json
{
  "llamacpp.serverUrl": "http://localhost:8000",
  "llamacpp.modelFamily": "auto",
  "llamacpp.contextLength": 65536,
  "llamacpp.cachePrompt": true,
  "llamacpp.autoCompact": true,
  "llamacpp.retryOnContextOverflow": true,
  "llamacpp.toolCallingMode": "apiDirect",
  "llamacpp.apiDirectIncludeAllTools": true,
  "llamacpp.apiDirectMaxTools": 128,
  "llamacpp.toolResultMode": "auto",
  "llamacpp.maxOutputTokensCap": 131072
}
```

## Quick Start: DeepSeek

Run `Llama.cpp: Configure DeepSeek`, paste your DeepSeek API key, then select
`deepseek-v4-pro` or `deepseek-v4-flash` in the chat model picker.

The command applies a max-quality DeepSeek profile:

```json
{
  "llamacpp.serverUrl": "https://api.deepseek.com",
  "llamacpp.modelFamily": "deepseek",
  "llamacpp.contextLength": 1048576,
  "llamacpp.maxOutputTokensCap": 393216,
  "llamacpp.thinkingMode": "deep",
  "llamacpp.toolCallingMode": "apiDirect",
  "llamacpp.apiDirectMaxTools": 128,
  "llamacpp.apiDirectIncludeAllTools": true,
  "llamacpp.toolResultMode": "auto",
  "llamacpp.requestTimeoutMs": 1200000,
  "llamacpp.requestQueueTimeoutMs": 1200000
}
```

For everyday coding work, `maxOutputTokensCap = 131072` is often a better
latency/context tradeoff than the full `393216` maximum. The full maximum
reserves a very large answer budget and can cause earlier history compaction.

## API Direct Tool Mode

`toolCallingMode = apiDirect` is the default and is the preferred mode for this
fork.

API Direct keeps tool calling enabled while reducing prompt overhead:

- Tool schemas are compacted.
- Descriptions are shortened.
- Tools are priority-ordered before applying the cap.
- `apiDirectMaxTools` controls the final tool count.
- `apiDirectIncludeAllTools = true` includes all advertised tools up to the cap.
- `maxToolsPerRequest` applies only to classic mode.

When `run_in_terminal` is available and tool mode is not strict-required, the
extension suppresses `create_and_run_task` and `run_vscode_command`. This nudges
the model toward direct terminal execution instead of VS Code command flows that
can open input prompts or duplicate shell behavior.

Classic mode is still available:

```json
{
  "llamacpp.toolCallingMode": "classic"
}
```

Use classic only if you need the unmodified full tool catalog and are willing to
pay the extra token cost.

## DeepSeek Compatibility Notes

DeepSeek V4 supports thinking mode and tool use, but it has a few important API
rules:

- In thinking mode, `reasoning_content` is streamed separately from final
  visible `content`.
- When an assistant message makes tool calls, its `reasoning_content` must be
  preserved in later request history.
- Sampling fields such as `temperature` and `top_p` are not useful in thinking
  mode.
- DeepSeek does not use llama.cpp-specific `cache_prompt`.

This fork handles those details in the provider:

- It reads streamed `reasoning_content`, `reasoning`, `thinking`, and
  `<think>...</think>` text.
- It sends DeepSeek `thinking.type` and `reasoning_effort`.
- It preserves `reasoning_content` on assistant tool-call messages.
- It skips llama.cpp-only and ignored thinking-mode parameters for DeepSeek.

## Context Management

The provider estimates prompt size before each request and can compact old
history when the conversation approaches the model context limit.

Important settings:

```json
{
  "llamacpp.contextUtilization": 0.85,
  "llamacpp.hardContextUtilization": 0.72,
  "llamacpp.compactKeepLastTurns": 12,
  "llamacpp.hardCompactKeepLastTurns": 6,
  "llamacpp.minReplyReserveTokens": 1536,
  "llamacpp.autoCompact": true,
  "llamacpp.retryOnContextOverflow": true
}
```

For DeepSeek V4, the provider uses a 1M context fallback when runtime metadata
does not report context length and `modelFamily` is `deepseek`.

VS Code's built-in context usage indicator can show `0` for third-party
providers. This extension exposes its own estimated context usage in the status
bar and Quick Access view.

## Tool Results

Large tool outputs can easily dominate the prompt. The extension protects the
model context with these defaults:

```json
{
  "llamacpp.maxToolResultChars": 24000,
  "llamacpp.summarizeLargeToolResults": true,
  "llamacpp.sanitizeToolResultArtifacts": true
}
```

Set `maxToolResultChars = 0` only when you explicitly need raw full tool output.

## Logging And Diagnostics

Logging is enabled by default but stream chunk logging is disabled by default.

```json
{
  "llamacpp.enableFileLogging": true,
  "llamacpp.logStreamChunks": false,
  "llamacpp.maxLoggedStreamChunkChars": 4096,
  "llamacpp.maxLogFiles": 20,
  "llamacpp.showPerformanceStatusBar": true,
  "llamacpp.showContextUsageStatusBar": true
}
```

Useful commands:

- `Llama.cpp: Open Logs Folder`
- `Llama.cpp: Open Latest Log`
- `Llama.cpp: Copy Latest Log Path`
- `Llama.cpp: Toggle File Logging`
- `Llama.cpp: Toggle Stream Chunk Logging`
- `Llama.cpp: Toggle Performance Status Bar`
- `Llama.cpp: Toggle Context Usage Status Bar`

Leave `logStreamChunks = false` during normal work. Turn it on only while
debugging stream parsing because it duplicates generated text into JSONL logs.

## Commands

- `Llama.cpp: Open Sidebar`
- `Manage Llama.cpp Provider`
- `Llama.cpp: Configure DeepSeek`
- `Llama.cpp: Set API Key`
- `Llama.cpp: Open Settings`
- `Llama.cpp: Set Thinking Mode`
- `Llama.cpp: Set Reasoning Budget`
- `Llama.cpp: Set Tool Result Mode`
- `Llama.cpp: Set Tool Calling Mode`
- `Llama.cpp: Refresh Models`
- `Llama.cpp: Open Copilot Model Picker`
- `Llama.cpp: Open Logs Folder`
- `Llama.cpp: Open Latest Log`
- `Llama.cpp: Copy Latest Log Path`

## Settings Reference

Core:

- `llamacpp.serverUrl`
- `llamacpp.contextLength`
- `llamacpp.modelFamily`
- `llamacpp.modelListCacheTtlMs`
- `llamacpp.modelDiscoveryTimeoutMs`
- `llamacpp.requestTimeoutMs`
- `llamacpp.requestQueueTimeoutMs`

Context and output:

- `llamacpp.autoCompact`
- `llamacpp.retryOnContextOverflow`
- `llamacpp.contextUtilization`
- `llamacpp.hardContextUtilization`
- `llamacpp.compactKeepLastTurns`
- `llamacpp.hardCompactKeepLastTurns`
- `llamacpp.maxOutputTokensCap`
- `llamacpp.minReplyReserveTokens`

Tools:

- `llamacpp.toolCallingMode`
- `llamacpp.apiDirectMaxTools`
- `llamacpp.apiDirectIncludeAllTools`
- `llamacpp.maxToolsPerRequest`
- `llamacpp.toolResultMode`
- `llamacpp.maxToolResultChars`
- `llamacpp.summarizeLargeToolResults`
- `llamacpp.sanitizeToolResultArtifacts`

Reasoning:

- `llamacpp.thinkingMode`
- `llamacpp.reasoningBudget`

Recovery:

- `llamacpp.emptyResponseAutoRetry`
- `llamacpp.emptyResponseAutoRetryMaxAttempts`
- `llamacpp.emptyResponseContinuationPrompt`
- `llamacpp.toolCallOnlyAutoretry`
- `llamacpp.toolCallOnlyAutoretryThreshold`

Logging:

- `llamacpp.enableFileLogging`
- `llamacpp.logStreamChunks`
- `llamacpp.maxLoggedStreamChunkChars`
- `llamacpp.showPerformanceStatusBar`
- `llamacpp.showContextUsageStatusBar`
- `llamacpp.maxLogFiles`

## Development

Install dependencies:

```sh
npm install
```

Compile:

```sh
npm run compile
```

Run tests:

```sh
npm test
```

Package a local VSIX:

```sh
npx @vscode/vsce package
```

Install the local VSIX:

```sh
code --install-extension .\llama-vscode-chat-0.2.11.vsix --force
```

After installing, run `Developer: Reload Window` in VS Code.

## Repository Notes

This is an independent personal fork. The original upstream remote can be kept
for reference, but development is intended to continue from this fork without
automatically pulling upstream changes.

## References

- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [DeepSeek API Docs](https://api-docs.deepseek.com/)
