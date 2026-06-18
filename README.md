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

DeepSeek API uses official OpenAI-format endpoints:

- `GET /models`
- `POST /chat/completions`

## Quick Start

1. Open command palette and run `Llama.cpp: Open Sidebar`.
2. Run `Manage Llama.cpp Provider` and set server URL.
3. Select a Llama.cpp model in chat model picker.
4. Start chatting.

### DeepSeek Quick Setup

1. Open command palette and run `Llama.cpp: Configure DeepSeek`.
2. Paste your DeepSeek API key when prompted (stored in VS Code Secret Storage).
3. Open chat model picker and choose `deepseek-v4-pro`.

The command applies a max-quality DeepSeek V4 profile:

- `contextLength = 1048576`
- `maxOutputTokensCap = 393216`
- `thinkingMode = deep` (`reasoning_effort=max`)
- `toolCallingMode = apiDirect`
- `apiDirectMaxTools = 128`
- `apiDirectIncludeAllTools = true`
- `toolResultMode = auto`

If you need to rotate credentials later, run `Llama.cpp: Set API Key`.

## Configuration

Main settings are under `llamacpp.*` in VS Code Settings.

- Context management:
  - `serverUrl`
  - `contextLength` (optional override; if not explicitly set, runtime context is inferred from `/slots` (`n_ctx`) first, then from model metadata)
  - `modelFamily`
  - `modelListCacheTtlMs`
  - `modelDiscoveryTimeoutMs`
  - `autoCompact`
  - `retryOnContextOverflow`
  - `emptyResponseAutoRetry`
  - `emptyResponseAutoRetryMaxAttempts`
  - `emptyResponseContinuationPrompt`
  - `contextUtilization`
  - `hardContextUtilization`
  - `compactKeepLastTurns`
  - `hardCompactKeepLastTurns`
  - `maxOutputTokensCap`: `128..393216` (default `131072`; set `393216` for maximum DeepSeek V4 output)
  - `minReplyReserveTokens`
  - `maxToolsPerRequest`
  - `requestTimeoutMs`
  - `requestQueueTimeoutMs`
  - `cachePrompt`
  - `maxToolResultChars`
  - `summarizeLargeToolResults`
  - `sanitizeToolResultArtifacts`
- Reasoning:
  - `thinkingMode`: `auto | off | light | balanced | deep`
  - `reasoningBudget`: `0..65536`
  - For DeepSeek endpoints, the provider sends `thinking.type` and `reasoning_effort`:
    - `off` -> `thinking.type=disabled` and no `reasoning_effort`
    - `light` / `balanced` / `auto` -> `thinking.type=enabled`, `reasoning_effort=high`
    - `deep` -> `thinking.type=enabled`, `reasoning_effort=max`
- Tool-result transport mode:
  - `toolResultMode`: `auto | tool | user`
  - `auto` starts with `role=tool` and falls back to `role=user` when backend chat template rejects tool-role messages.
- Tool calling mode:
  - `toolCallingMode`: `classic | apiDirect`
  - `apiDirectMaxTools`: `1..128` (used when `toolCallingMode = apiDirect`)
  - `apiDirectIncludeAllTools`: `true | false` (when true, includes all available tools up to `apiDirectMaxTools`)
  - `classic` keeps current full tool catalog behavior.
  - `apiDirect` sends a compact prioritized tool subset to reduce token overhead while keeping tool calls enabled.
  - When `run_in_terminal` is available and tool mode is not strict-required, `run_vscode_command` is suppressed to avoid command-execution flows that open VS Code input boxes instead of running shell commands.
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
  - `Llama.cpp: Configure DeepSeek`
  - `Llama.cpp: Set API Key`
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
- Keep `modelDiscoveryTimeoutMs = 20000` for remote providers (for example DeepSeek) so model loading fails fast instead of hanging on a stalled network call.
- DeepSeek note: `Llama.cpp: Configure DeepSeek` sets `contextLength = 1048576` for the official 1M-token V4 context. If `/models` does not expose context metadata, provider also falls back to 1M for DeepSeek models unless you explicitly override `contextLength`.
- Keep `cachePrompt = true` so llama.cpp can reuse its server-side prompt/KV cache for repeated prefixes.
- Chat completions are serialized through one local request slot. This keeps a single llama.cpp server from running overlapping generations and makes `cache_prompt` much more likely to reuse the same warm prompt prefix.
- DeepSeek context caching is automatic on the API side; the provider does not send llama.cpp-specific `cache_prompt` to DeepSeek endpoints.
- Keep `requestQueueTimeoutMs = 1200000` unless you prefer queued requests to fail faster while another local generation is running.
- Keep `maxToolResultChars = 24000` for coding-agent work. It prevents one huge tool/file result from consuming most of the prompt; set it to `0` only when you explicitly need full raw tool payloads.
- Keep `summarizeLargeToolResults = true` so very large tool payloads are summarized instead of injecting long partial JSON/log fragments into context.
- Keep `sanitizeToolResultArtifacts = true` so transient metadata blobs (for example `cache_control` JSON tails) are removed from tool output before model ingestion.
- Keep `autoCompact = true`.
- Keep `retryOnContextOverflow = true`.
- Keep `emptyResponseAutoRetry = true` so the provider automatically asks the model to continue when a turn unexpectedly ends with no text and no tool call.
- Start with `emptyResponseAutoRetryMaxAttempts = 1` to avoid runaway loops.
- Start with:
  - `contextUtilization = 0.85`
  - `hardContextUtilization = 0.72`
  - `compactKeepLastTurns = 12`
  - `hardCompactKeepLastTurns = 6`
  - `maxOutputTokensCap = 131072`
  - `requestTimeoutMs = 1200000`
- For DeepSeek V4 Pro maximum output, use `maxOutputTokensCap = 393216`; for everyday latency/cost control, `131072` is usually plenty.
- Use `toolResultMode = auto` unless your model already reliably supports `role=tool`.
- Default `toolCallingMode = apiDirect` so tool execution stays in direct API flow.
- Use `apiDirectMaxTools = 128` and `apiDirectIncludeAllTools = true` for full tool coverage.
- In apiDirect mode, request-level `maxToolsPerRequest` cap is bypassed; tool count is governed by `apiDirectMaxTools`.
- Even with `apiDirectIncludeAllTools = true`, tools are priority-ordered before cap/slice so core execution tools (for example `run_in_terminal`) stay available under request-level tool limits.
- Tool suppression: when `run_in_terminal` is available, `create_and_run_task` and `run_vscode_command` are removed from the tool list. This prevents the model from opening VS Code input prompts instead of running terminal commands directly.
- For MCP-provided tools (Ghidra, scooter tools, etc.): they are included in the apiDirect tool set alongside VS Code native tools with no special filtering — all advertised tools up to `apiDirectMaxTools` are passed to the model.

## Tool Execution Design (apiDirect mode)

When `toolCallingMode = apiDirect` (the default):

| Condition | Behavior |
| --- | --- |
| `run_in_terminal` is available | `create_and_run_task` and `run_vscode_command` are suppressed to avoid VS Code input prompts |
| `apiDirectIncludeAllTools = true` (default) | All tools flow through, priority-ordered, capped by `apiDirectMaxTools` |
| `apiDirectMaxTools = 128` (default) | Full VS Code + MCP tool catalog reaches the model |
| Classic mode fallback | `maxToolsPerRequest` cap applies; no tool suppression; full schemas (not compacted) |

- Use `thinkingMode = deep` for maximum DeepSeek V4 Pro reasoning quality. Use `balanced` (or `auto`) when latency and cost matter more.
- Leave `logStreamChunks = false` during normal work. Turn it on only while debugging stream parsing because it duplicates generated text into JSONL logs.

If a response reaches max output tokens, the extension appends a hint in chat output so this is visible (instead of appearing as a silent stop).

## Troubleshooting

- DeepSeek models do not appear in picker:
  - Run `Llama.cpp: Configure DeepSeek` again and paste a valid DeepSeek API key.
  - If key validation fails with `401 Unauthorized`, rotate/re-copy the key in `Llama.cpp: Set API Key`.
  - Use `Llama.cpp: Refresh Models` after updating the key.
- Raw JSON/JSONL hangs in terminal:
  - Avoid dumping entire files to terminal.
  - Use bounded reads, for example:
    - `head -n 80 <path-to-log.jsonl>`
    - `rg -n "models.request|models.http.response|models.request.failed" <path-to-log.jsonl>`
    - `tail -n 120 <path-to-log.jsonl>`

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
