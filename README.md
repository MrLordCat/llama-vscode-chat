# Llama.cpp Provider for GitHub Copilot Chat

This extension connects OpenAI-compatible Llama.cpp endpoints to VS Code Chat.

## Features

- Streaming chat responses.
- Tool calling with compatibility fallback for strict chat templates.
- Context-aware compaction and overflow retry.
- Thinking controls for compatible models (for example Qwen):
  - `thinkingMode`
  - `reasoningBudget`
- Streaming thinking visibility from `reasoning`, `reasoning_content`, and `<think>...</think>` chunks (with fallback text mode on older VS Code APIs).
- Quick Actions view in the Activity Bar.
- Throughput telemetry for each turn (estimated tokens/sec, first-token latency, queue wait).
- Optional status bar throughput indicator with latest turn metrics.
- Optional context-usage status bar with budget breakdown (`messages`, `tools`, `reserved`, free headroom).
- Full JSONL request/response logs with quick access commands.

## Requirements

- VS Code 1.104.0 or newer.
- Running Llama.cpp server with OpenAI-compatible API:
  - `GET /v1/models`
  - `POST /v1/chat/completions`

## Quick Start

1. Open command palette and run `Llama.cpp: Open Sidebar`.
2. Run `Manage Llama.cpp Provider` and set server URL.
3. Select a Llama.cpp model in chat model picker.
4. Start chatting.

## Configuration

Main settings are under `llamacpp.*` in VS Code Settings.

- Context management:
  - `serverUrl`
  - `contextLength` (optional override; if not explicitly set, runtime context is inferred from `/slots` (`n_ctx`) first, then from `/v1/models` metadata)
  - `modelFamily`
  - `modelListCacheTtlMs`
  - `autoCompact`
  - `retryOnContextOverflow`
  - `emptyResponseAutoRetry`
  - `emptyResponseAutoRetryMaxAttempts`
  - `emptyResponseContinuationPrompt`
  - `contextUtilization`
  - `hardContextUtilization`
  - `compactKeepLastTurns`
  - `hardCompactKeepLastTurns`
  - `maxOutputTokensCap`
  - `minReplyReserveTokens`
  - `maxToolsPerRequest`
  - `requestTimeoutMs`
  - `requestQueueTimeoutMs`
  - `cachePrompt`
  - `maxToolResultChars`
- Reasoning:
  - `thinkingMode`: `auto | off | light | balanced | deep`
  - `reasoningBudget`: `0..65536`
- Tool-result transport mode:
  - `toolResultMode`: `auto | tool | user`
  - `auto` starts with `role=tool` and falls back to `role=user` when backend chat template rejects tool-role messages.
- Logging:
  - `enableFileLogging`: enable/disable file logs
  - `logStreamChunks`: include stream chunks when deep diagnostics are needed
  - `maxLoggedStreamChunkChars`: per-chunk log payload limit
  - `showPerformanceStatusBar`: show/hide llama.cpp TPS status bar item
  - `showContextUsageStatusBar`: show/hide llama.cpp context usage status bar item
  - `maxLogFiles`: automatic retention limit for old logs

## Logging And Fast Access

To simplify troubleshooting during long chat sessions, the extension now writes detailed JSONL logs for every request.

- Quick commands:
  - `Llama.cpp: Refresh Models`
  - `Llama.cpp: Open Logs Folder`
  - `Llama.cpp: Open Latest Log`
  - `Llama.cpp: Copy Latest Log Path`
  - `Llama.cpp: Toggle Performance Status Bar`
  - `Llama.cpp: Toggle Context Usage Status Bar`
- The same actions are also available in the Llama.cpp Quick Access sidebar.

Logs include:

- Request configuration and payload (`messages`, tools, budgets, thinking mode).
- HTTP status/errors and retry/fallback decisions.
- Optional bounded streaming chunks (when `logStreamChunks = true`).
- Per-turn performance metrics (`tokensPerSecond`, `firstTokenLatencyMs`, `queueWaitMs`, estimated output tokens, thinking chars).

Default logs location is inside extension global storage under `logs/`.

## Recommended Profile For Large Context Agent Work

If you use this model as a daily coding agent with long sessions:

- Set `serverUrl = http://localhost:8000` when your local server listens on port 8000.
- Set `contextLength = 65536` for a 64k llama.cpp runtime context.
- Keep `modelFamily = auto`; Qwen model ids are advertised to VS Code Chat as `qwen`.
- Keep `modelListCacheTtlMs = 30000` so model discovery is fast and the picker can reuse the last successful list during brief server hiccups.
- Keep `cachePrompt = true` so llama.cpp can reuse its server-side prompt/KV cache for repeated prefixes.
- Chat completions are serialized through one local request slot. This keeps a single llama.cpp server from running overlapping generations and makes `cache_prompt` much more likely to reuse the same warm prompt prefix.
- Keep `requestQueueTimeoutMs = 1200000` unless you prefer queued requests to fail faster while another local generation is running.
- Keep `maxToolResultChars = 24000` for coding-agent work. It prevents one huge tool/file result from consuming most of the prompt; set it to `0` only when you explicitly need full raw tool payloads.
- Keep `autoCompact = true`.
- Keep `retryOnContextOverflow = true`.
- Keep `emptyResponseAutoRetry = true` so the provider automatically asks the model to continue when a turn unexpectedly ends with no text and no tool call.
- Start with `emptyResponseAutoRetryMaxAttempts = 1` to avoid runaway loops.
- Start with:
  - `contextUtilization = 0.85`
  - `hardContextUtilization = 0.72`
  - `compactKeepLastTurns = 12`
  - `hardCompactKeepLastTurns = 6`
  - `maxOutputTokensCap = 8192`
  - `requestTimeoutMs = 1200000`
- Use `toolResultMode = auto` unless your model already reliably supports `role=tool`.
- Use `thinkingMode = balanced` (or `auto`) for better latency/quality balance.
- Leave `logStreamChunks = false` during normal work. Turn it on only while debugging stream parsing because it duplicates generated text into JSONL logs.

If a response reaches max output tokens, the extension appends a hint in chat output so this is visible (instead of appearing as a silent stop).

## Known Limitation: Context Usage In VS Code Chat

You may see current context usage shown as `0` in VS Code Chat for third-party providers, while GitHub Copilot models display usage.

- This extension still performs internal token estimation and context budgeting before each request.
- The built-in usage indicator behavior for custom providers is currently limited and may not reflect real usage even when requests are processed correctly.
- In practice, this means you can still see `0` in the UI even while long requests are being compacted and token-limited internally.
- To compensate, this extension exposes its own live context estimate and category breakdown in the Llama.cpp status bar item and Quick Actions view.

## Development

1. Clone the repository.

```sh
git clone https://github.com/mbeps/llama-vscode-chat.git
cd llama-vscode-chat
```

1. Install dependencies.

```sh
npm install
```

1. Compile.

```sh
npm run compile
```

1. Run tests.

```sh
npm run test
```

1. Package local VSIX.

```sh
npx @vscode/vsce package -o llama-vscode-chat-local.vsix
```

## References

- [Llama.cpp](https://github.com/ggerganov/llama.cpp)
- [VS Code Extension API](https://code.visualstudio.com/api)
