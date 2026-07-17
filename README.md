# Local LLM Chat Provider for VS Code

Independent extension by MrLordCat focused on making VS Code Chat work well
with OpenAI-compatible local servers and the official DeepSeek API.

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
- Keep durable shared memory available across chats, workspaces, and models.

## Main Features

- OpenAI-compatible chat completions:
  - llama.cpp: `GET /v1/models`, `POST /v1/chat/completions`
  - DeepSeek: `GET /models`, `POST /chat/completions`
- Multiple model sources at the same time:
  - primary OpenAI-compatible server from `llamacpp.serverUrl`
  - dedicated local server from `llamacpp.localServerUrl`
  - DeepSeek API from `https://api.deepseek.com`
- Adaptive text/reasoning chunk coalescing to reduce VS Code UI stalls, with
  upstream stream cancellation so stopped turns release the llama.cpp slot.
- Tool calling with OpenAI `tools` and `tool` result messages.
- API Direct tool mode for compact tool schemas and prioritized tool selection.
- DeepSeek thinking-mode support:
  - `thinking.type`
  - `reasoning_effort`
  - streamed `reasoning_content`
  - preservation of `reasoning_content` for assistant tool-call turns
- Context budgeting, auto-compaction, and context-overflow retry.
- Exact local prompt counting through llama.cpp `/apply-template` and
  `/tokenize`, with a heuristic fallback for other servers.
- Code-aware history compaction and structured large tool-result summaries.
- Tool-result artifact sanitization for transient metadata blobs.
- Bounded pre-stream retry for transient network, rate-limit, and gateway
  failures.
- Request queueing for single-slot local llama.cpp generation.
- Optional JSONL file logging.
- Status bar metrics for throughput and context usage.
- Compact Quick Access sidebar with grouped connections, model behavior,
  memory, and diagnostics.
- Shared memory with automatic relevance-based context injection and native
  Agent mode tools for create, search, update, and delete operations.
- Optional Copilot Chat patch for native context limits and session-scoped
  Thinking Effort controls on extension-provided models.

## Quick Start: Local llama.cpp

Start llama.cpp with an OpenAI-compatible server, for example:

```sh
llama-server -m path/to/model.gguf --host 127.0.0.1 --port 8000 --ctx-size 65536
```

Then in VS Code:

1. Run `Local LLM: Open Sidebar`.
2. Run `Local LLM: Set Local Server URL`.
3. Set local server URL, for example `http://localhost:8000`.
4. Run `Local LLM: Refresh Models`.
5. Open the chat model picker and select a `llamacpp` model.

Recommended local defaults:

```json
{
  "llamacpp.enableLocalServer": true,
  "llamacpp.localServerUrl": "http://localhost:8000",
  "llamacpp.localContextLength": 65536,
  "llamacpp.modelFamily": "auto",
  "llamacpp.cachePrompt": true,
  "llamacpp.autoCompact": true,
  "llamacpp.accurateTokenCounting": true,
  "llamacpp.retryOnContextOverflow": true,
  "llamacpp.thinkingMode": "deep",
  "llamacpp.reasoningBudget": 16384,
  "llamacpp.preserveThinking": true,
  "llamacpp.toolCallingMode": "apiDirect",
  "llamacpp.apiDirectIncludeAllTools": false,
  "llamacpp.apiDirectMaxTools": 48,
  "llamacpp.apiDirectToolTokenBudget": 12000,
  "llamacpp.toolResultMode": "auto",
  "llamacpp.localDefaultMaxOutputTokens": 32768,
  "llamacpp.maxOutputTokensCap": 131072
}
```

## Quick Start: DeepSeek

Run `Local LLM: Configure DeepSeek`, paste your DeepSeek API key, then select
`deepseek-v4-pro` or `deepseek-v4-flash` in the chat model picker. This does
not replace the local server URL; DeepSeek is advertised as a separate source
alongside local models.

DeepSeek credentials are stored separately from the generic primary-server API
key. Existing installations can still fall back to the legacy shared key, while
running `Configure DeepSeek` writes the dedicated secret.

The command enables the DeepSeek source and applies a max-quality request
profile:

```json
{
  "llamacpp.enableDeepSeek": true,
  "llamacpp.maxOutputTokensCap": 393216,
  "llamacpp.deepSeekDefaultMaxOutputTokens": 65536,
  "llamacpp.thinkingMode": "deep",
  "llamacpp.toolCallingMode": "apiDirect",
  "llamacpp.apiDirectMaxTools": 48,
  "llamacpp.apiDirectIncludeAllTools": false,
  "llamacpp.apiDirectToolTokenBudget": 12000,
  "llamacpp.toolResultMode": "auto",
  "llamacpp.requestTimeoutMs": 1200000,
  "llamacpp.requestQueueTimeoutMs": 1200000
}
```

`deepSeekDefaultMaxOutputTokens` is the normal per-turn request. The larger
`maxOutputTokensCap` is only an absolute ceiling for sessions that explicitly
request more output, so keeping the DeepSeek maximum available no longer forces
every turn to reserve 393216 tokens.

## Model Sources

The provider can advertise models from several OpenAI-compatible endpoints at
once. In the VS Code model picker they are shown with their source label, for
example `qwen3-local (Local)` and `deepseek-v4-pro (DeepSeek)`.

Internally the provider keeps source-prefixed model ids such as
`local::qwen3-local` and `deepseek::deepseek-v4-pro`, then strips the prefix
before sending the HTTP request. That lets one chat provider route each request
to the correct endpoint without changing `llamacpp.serverUrl`.

Source settings:

```json
{
  "llamacpp.serverUrl": "http://localhost:8000",
  "llamacpp.enableLocalServer": true,
  "llamacpp.localServerUrl": "http://localhost:8000",
  "llamacpp.localContextLength": 65536,
  "llamacpp.enableDeepSeek": true
}
```

`llamacpp.localContextLength` is only a fallback. The provider prefers the
runtime value reported by llama.cpp `/slots`. The model's training limit from
`/v1/models` can be much larger than the context allocated to the running
server; the runtime value is the one that requests must obey.

For local models, the provider also keeps the advertised default output budget
to a safe share of the context, capped at 32768 tokens. This prevents a large
global DeepSeek output cap from reserving almost the entire local context and
breaking compaction.

## API Direct Tool Mode

`toolCallingMode = apiDirect` is the default and is the preferred mode for this
fork.

API Direct keeps tool calling enabled while reducing prompt overhead:

- Tool schemas are compacted.
- Descriptions are shortened.
- Tools are priority-ordered before applying the cap.
- `apiDirectMaxTools` controls the final tool count.
- `apiDirectToolTokenBudget` limits the approximate serialized schema cost.
- `apiDirectIncludeAllTools = false` keeps the efficient prioritized subset.
- Strict required-tool requests always retain the requested tool.
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

## Reasoning And Output Budgets

The controls have separate jobs:

- `thinkingMode` selects the reasoning profile.
- `reasoningBudget` is a local hidden-reasoning cap, not the answer length.
- `localDefaultMaxOutputTokens` and `deepSeekDefaultMaxOutputTokens` are normal
  `max_tokens` values when VS Code does not request an explicit limit.
- `maxOutputTokensCap` is the final safety ceiling.

For local llama.cpp requests, Light uses up to 512 hidden tokens, Balanced up
to 2048, and High/Deep/Auto use `reasoningBudget`. The extension sends
`chat_template_kwargs.enable_thinking` and `thinking_budget_tokens`, which are
recognized by the maintained llama.cpp server fork. `max_tokens` includes both
hidden reasoning and visible output, so it must remain larger than the reasoning
cap.

For Qwen 3.6, `preserveThinking` also sends
`chat_template_kwargs.preserve_thinking=true` so multi-step tool turns can reuse
reasoning traces that VS Code returns in history. The default Qwen sampling
profile uses temperature 0.6, top-p 0.95, top-k 20, min-p 0, and presence
penalty 0 unless the chat session supplies explicit values.

DeepSeek does not consume the numeric local budget. It receives High effort for
Auto/Light/Balanced and Max effort for Deep. See
[Tokens, Reasoning, And Prompt Cache](docs/TOKENS_REASONING_CACHE.md) for the
complete mapping, recommended profiles, and cache diagnostics.

## Context Management

For local llama.cpp servers, the provider applies the active chat template and
tokenizes the complete messages + tools prompt before each request. Results are
cached briefly. Servers without those endpoints, and DeepSeek, use the existing
conservative estimate. Old history is compacted when the resolved count
approaches the model context limit.

Compaction is deterministic and does not run an extra model generation. It
keeps complete user turns so assistant tool calls are never separated from
their tool results, and extracts bounded decisions, file paths, diagnostics,
code edges, and next steps from older turns. The compact operation and exact
tokenizer preflight have separate durations in logs (`compactDurationMs` and
`chat.tokens.count.durationMs`), which makes server-side tokenizer latency easy
to distinguish from history processing.

Copilot Chat also has its own LLM-based conversation summarizer. The optional
bundle patch keeps that outer summarizer from starting in the background for
this provider, gives it the complete advertised context window, ignores smaller
session and global summary thresholds, and prevents the unfiltered host tool
catalog from consuming the budget before API Direct selection. Foreground
summarization remains available near the real host limit. When Copilot does
request one, the provider recognizes its internal prompt and uses a bounded
no-reasoning profile instead of the normal Qwen High/Deep profile.

Important settings:

```json
{
  "llamacpp.contextUtilization": 0.85,
  "llamacpp.hardContextUtilization": 0.72,
  "llamacpp.compactKeepLastTurns": 12,
  "llamacpp.hardCompactKeepLastTurns": 6,
  "llamacpp.minReplyReserveTokens": 1536,
  "llamacpp.autoCompact": true,
  "llamacpp.copilotCompactionFastMode": true,
  "llamacpp.copilotCompactionMaxTokens": 2048,
  "llamacpp.accurateTokenCounting": true,
  "llamacpp.tokenizerTimeoutMs": 10000,
  "llamacpp.retryOnContextOverflow": true
}
```

For the dedicated DeepSeek source, the provider uses DeepSeek family handling
and a 1M context fallback even when the global `modelFamily`/`contextLength`
settings are tuned for local models.

The provider advertises `maxInputTokens + maxOutputTokens` as the complete
runtime window and implements token counting for VS Code's built-in context
indicator. It requests exact streamed usage from llama.cpp and DeepSeek and
forwards it to Copilot's native Session Info panel. If a compatible server omits
usage, the panel receives an estimate instead of remaining at `0 / N tokens`.
The extension also keeps its detailed budget estimate in the status bar and
Quick Access view.

## Native Copilot Controls

VS Code's native Thinking Effort schema is not part of the stable third-party
provider API. This repository includes an opt-in, version-checked patch for the
bundled Copilot Chat extension:

```sh
npm run patch:copilot:status
npm run patch:copilot
```

After applying the patch and installing the VSIX, run `Developer: Reload
Window`. Local models expose `None`, `Low`, `Medium`, and `High`; DeepSeek
exposes `High` and `Max`. The selected value belongs to the current chat session
and overrides `llamacpp.thinkingMode` for that request.

The patch creates a backup and can be reverted:

```sh
npm run patch:copilot:restore
```

VS Code updates replace the patched bundle. Re-run `status` and apply it again
after an update. See [docs/COPILOT_PATCH.md](docs/COPILOT_PATCH.md) for the exact
scope, safeguards, and portable-build options.

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

## Shared Memory

Durable memory is owned by this extension. It is stored once
in VS Code extension global storage and is therefore shared by local models,
DeepSeek, chats, and workspaces on the same VS Code profile.

Relevant entries are automatically added immediately before the latest user
turn with a separate budget. This preserves the stable conversation prefix for
llama.cpp prompt-cache reuse:

```json
{
  "llamacpp.memoryEnabled": true,
  "llamacpp.memoryAutoInject": true,
  "llamacpp.memoryMaxTokens": 4096
}
```

The extension contributes three native Agent mode tools:

- `llamacpp_store_memory` creates or updates a durable entry.
- `llamacpp_search_memory` retrieves exact entries on demand.
- `llamacpp_delete_memory` removes an obsolete entry.

Writing and deleting memory requires VS Code tool confirmation. The model
should store stable preferences, project decisions, environment facts, and
reusable workflow knowledge. Secrets, unverified guesses, and temporary chat
details should not be stored.

Use `Local LLM: Open Shared Memory` to inspect the JSON file and
`Local LLM: Clear Shared Memory` to reset it. Saving a valid edited memory file
reloads it immediately. See [Shared Memory](docs/MEMORY.md) for the format,
limits, retrieval behavior, and security model.

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

- `Local LLM: Open Logs Folder`
- `Local LLM: Open Latest Log`
- `Local LLM: Copy Latest Log Path`
- `Local LLM: Toggle File Logging`
- `Local LLM: Toggle Stream Chunk Logging`
- `Local LLM: Toggle Performance Status Bar`
- `Local LLM: Toggle Context Usage Status Bar`

Leave `logStreamChunks = false` during normal work. Turn it on only while
debugging stream parsing because it duplicates generated text into JSONL logs.

## Quick Access Sidebar

The sidebar keeps frequent actions in the view title:

- choose the active chat model;
- refresh discovered models;
- open extension settings.

The tree itself is split into four stable groups:

- `Connections`: primary/local endpoints, source toggles, and API setup;
- `Model Behavior`: global thinking default, local reasoning cap, and tool modes;
- `Memory`: shared memory state and destructive clear action;
- `Diagnostics`: context/throughput metrics, logs, logging, and status bar
  toggles.

Connections and model behavior start expanded. Memory and diagnostics start
collapsed, while their descriptions still show the useful current state. Full
endpoint URLs are available as tooltips instead of stretching the sidebar.

## Commands

- `Local LLM: Open Sidebar`
- `Local LLM: Manage Primary Server`
- `Local LLM: Set Local Server URL`
- `Local LLM: Toggle Local Server Source`
- `Local LLM: Toggle DeepSeek Source`
- `Local LLM: Configure DeepSeek`
- `Local LLM: Set Primary API Key`
- `Local LLM: Open Settings`
- `Local LLM: Open Shared Memory`
- `Local LLM: Clear Shared Memory`
- `Local LLM: Set Thinking Mode`
- `Local LLM: Set Local Reasoning Cap`
- `Local LLM: Set Tool Result Mode`
- `Local LLM: Set Tool Calling Mode`
- `Local LLM: Refresh Models`
- `Local LLM: Open Copilot Model Picker`
- `Local LLM: Open Logs Folder`
- `Local LLM: Open Latest Log`
- `Local LLM: Copy Latest Log Path`

## Settings Reference

Core:

- `llamacpp.serverUrl`
- `llamacpp.enableLocalServer`
- `llamacpp.localServerUrl`
- `llamacpp.localContextLength`
- `llamacpp.enableDeepSeek`
- `llamacpp.contextLength`
- `llamacpp.modelFamily`
- `llamacpp.modelListCacheTtlMs`
- `llamacpp.modelDiscoveryTimeoutMs`
- `llamacpp.requestTimeoutMs`
- `llamacpp.requestQueueTimeoutMs`
- `llamacpp.transientRetryMaxAttempts`
- `llamacpp.transientRetryBaseDelayMs`

Context and output:

- `llamacpp.autoCompact`
- `llamacpp.copilotCompactionFastMode`
- `llamacpp.copilotCompactionMaxTokens`
- `llamacpp.accurateTokenCounting`
- `llamacpp.tokenizerTimeoutMs`
- `llamacpp.retryOnContextOverflow`
- `llamacpp.contextUtilization`
- `llamacpp.hardContextUtilization`
- `llamacpp.compactKeepLastTurns`
- `llamacpp.hardCompactKeepLastTurns`
- `llamacpp.maxOutputTokensCap`
- `llamacpp.localDefaultMaxOutputTokens`
- `llamacpp.deepSeekDefaultMaxOutputTokens`
- `llamacpp.minReplyReserveTokens`

Tools:

- `llamacpp.toolCallingMode`
- `llamacpp.apiDirectMaxTools`
- `llamacpp.apiDirectIncludeAllTools`
- `llamacpp.apiDirectToolTokenBudget`
- `llamacpp.maxToolsPerRequest`
- `llamacpp.toolResultMode`
- `llamacpp.maxToolResultChars`
- `llamacpp.summarizeLargeToolResults`
- `llamacpp.sanitizeToolResultArtifacts`

Reasoning:

- `llamacpp.thinkingMode`
- `llamacpp.reasoningBudget`
- `llamacpp.preserveThinking`

Memory:

- `llamacpp.memoryEnabled`
- `llamacpp.memoryAutoInject`
- `llamacpp.memoryMaxTokens`

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

Run all checks:

```sh
npm run check
```

Package a local VSIX:

```sh
npm run package
```

Install the local VSIX:

```sh
code --install-extension .\llama-vscode-chat-1.0.0.vsix --force
```

After installing, run `Developer: Reload Window` in VS Code.

## Repository Notes

This is an independent extension maintained at
`MrLordCat/llama-vscode-chat`. The `llamacpp.*` setting keys, command ids, and
provider vendor are intentionally retained so existing local configuration
continues to work. The Marketplace/local extension id is now
`mrlordcat.llama-vscode-chat`.

The complete feature history and ownership boundaries are in [Fork Changes](docs/FORK_CHANGES.md).
Runtime structure and the current refactoring roadmap are in
[Architecture](docs/ARCHITECTURE.md) and [Project Audit](docs/AUDIT.md).

## References

- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [DeepSeek API Docs](https://api-docs.deepseek.com/)
