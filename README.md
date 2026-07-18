# Local LLM Chat Provider for VS Code

**One Copilot Chat workflow for Codex, DeepSeek, local LLMs, and planned Claude subscription support.**

Local LLM Chat Provider connects multiple model backends to the native VS Code
model picker and Copilot Chat. Local models, remote OpenAI-compatible APIs,
DeepSeek, and subscription-backed Codex models can coexist in one chat UI and
use the same agent tools, approvals, history, and diagnostics.

The project started as a fork of a llama.cpp chat provider. It is now maintained
as a heavily rewritten and substantially expanded independent extension. The
existing `llamacpp.*` settings, commands, and provider vendor are retained for
backward compatibility, but the product is no longer limited to llama.cpp.

## Project Goal

The goal is to make Copilot Chat a single front end for different model and
subscription sources:

- keep local, API-backed, and subscription-backed models available together;
- switch models without switching chats, extensions, or global endpoint URLs;
- let every model use Copilot's native file, terminal, search, web, and memory
  tools through the same visible tool cards and approval flow;
- avoid redundant model turns and full-history resends;
- maximize useful context and prompt-cache reuse;
- provide one extensible integration point for Claude and future subscription providers.

## Model Sources

| Source | Status | Integration |
| --- | --- | --- |
| Local llama.cpp | Available | OpenAI-compatible model discovery and chat completions |
| Other OpenAI-compatible servers | Available | Configurable primary endpoint and API key |
| DeepSeek | Available | Official API, separate credentials, reasoning support |
| OpenAI Codex subscription | Available | Official local `codex app-server` and ChatGPT account |
| Anthropic Claude subscription | Planned | Future adapter behind the same Copilot Chat flow |

All enabled sources appear together in the native model picker with labels such
as `(Local)`, `(DeepSeek)`, and `(Codex)`. Internal source prefixes route each
request to the correct transport and are never sent to the upstream model.

## Key Features

### Unified Copilot Chat Flow

- Multiple model sources remain enabled at the same time.
- Model selection stays in the native Copilot Chat picker.
- Local and API credentials are isolated in VS Code SecretStorage.
- Codex authentication remains owned by the official Codex process; this
  extension does not read or copy `~/.codex/auth.json`.

### Efficient Tools and Agent Execution

- Models select from Copilot's current outer tool catalog.
- Commands, files, searches, web access, memory, and private caller tools are
  executed by Copilot with native cards and the current approval mode.
- Large catalogs use deferred schema loading so uncommon tools do not occupy
  every prompt.
- Parallel Codex tool calls are returned as one native batch.
- Tool names and arguments are repaired only when deterministic, validated
  against advertised schemas, and protected from repeated-call loops.

### Context and Cache Efficiency

- Context budgets include messages, tool schemas, memory, and reply reserve.
- Large tool results are sanitized, summarized, and bounded.
- Long histories are compacted without leaving orphaned tool calls.
- llama.cpp can use exact `/apply-template` and `/tokenize` prompt counts.
- Stable prompt prefixes and late memory injection improve local/DeepSeek cache
  reuse.
- Codex tool-result rounds continue the same app-server turn.
- Completed Codex threads can be reused for ordinary follow-ups, sending only
  incremental input instead of the full Copilot conversation.

### Reasoning, Streaming, and Reliability

- Native thinking/reasoning is separated from visible answer text.
- Local and DeepSeek request profiles keep provider-specific fields isolated.
- Stream chunks are coalesced to reduce UI pressure during long answers.
- Cancellation stops upstream generation and releases local server capacity.
- Transient failures, context overflow, incompatible tool-result roles, and
  empty output have separate bounded recovery paths.
- Exact upstream usage is forwarded to Copilot Session Info when available.

### Memory and Diagnostics

- Scoped shared memory supports typed entries, provenance, expiry, retrieval,
  automatic bounded injection, and native Agent tools.
- Quick Access groups connections, model behavior, memory, and diagnostics.
- Health checks, session-quality reports, context usage, cache hit rate,
  throughput, and Codex thread reuse are visible without logging prompt bodies.
- Optional JSONL diagnostics make routing and performance issues inspectable.

## Quick Start

Open `Local LLM: Open Sidebar`, configure one or more sources, run
`Local LLM: Refresh Models`, and choose a model from the Copilot Chat picker.

### Local llama.cpp

Start an OpenAI-compatible llama.cpp server:

```sh
llama-server -m path/to/model.gguf --host 127.0.0.1 --port 8000 --ctx-size 65536
```

Then run `Local LLM: Set Local Server URL` and use
`http://localhost:8000` unless the server is listening elsewhere.

### DeepSeek

Run `Local LLM: Configure DeepSeek`, enter the DeepSeek API key, refresh the
model list, and select a model labelled `(DeepSeek)`. DeepSeek uses a dedicated
secret and does not replace the local or primary server configuration.

### Codex Subscription

1. Install the official OpenAI Codex VS Code extension or put Codex CLI on
   `PATH`.
2. Run `Local LLM: Sign In to Codex Subscription` or reuse an existing
   `codex login` session.
3. Refresh models and select a model labelled `(Codex)`.

The provider accepts ChatGPT subscription authentication and refuses Codex
API-key mode to avoid accidental API billing through this route. See
[Codex Subscription](docs/CODEX_SUBSCRIPTION.md) for the full security and
runtime model.

## Optimized Copilot Integration

The stable VS Code provider API does not expose every Copilot model control.
This repository therefore includes an optional, version-checked patch for the
bundled Copilot Chat extension:

```sh
npm run patch:copilot:status
npm run patch:copilot
```

For models from this provider, the patch enables the advertised context/output
limits, native session-scoped Thinking Effort, provider-owned context budgeting,
and a stable Copilot conversation identity for safe Codex thread reuse. It is
fail-closed, validates the patched JavaScript, and creates a restorable backup.

Run `Developer: Reload Window` after applying it. VS Code updates replace the
patched bundle, so check and reapply it after an update. Details and restoration
steps are in [Copilot Chat Integration](docs/COPILOT_PATCH.md).

## Important Commands

| Command | Purpose |
| --- | --- |
| `Local LLM: Open Sidebar` | Open Quick Access |
| `Local LLM: Set Local Server URL` | Configure the local endpoint |
| `Local LLM: Configure DeepSeek` | Store the DeepSeek key and enable the source |
| `Local LLM: Sign In to Codex Subscription` | Authenticate the Codex app-server |
| `Local LLM: Refresh Models` | Refresh every enabled source |
| `Local LLM: Choose Chat Model` | Select a model in the native picker |
| `Local LLM: Run Provider Health Check` | Probe configured sources and runtime features |
| `Local LLM: Open Session Quality Report` | Inspect cache, latency, context, and tool metrics |
| `Local LLM: Open Shared Memory` | Inspect durable shared memory |
| `Local LLM: Open Latest Log` | Open the newest structured diagnostic log |

All settings live under `llamacpp.*`. Use the Quick Access sidebar or
`Local LLM: Open Settings` instead of copying a large static settings profile.

## Documentation

| Document | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Runtime boundaries and request flow |
| [Fork Changes](docs/FORK_CHANGES.md) | Evolution from the original fork |
| [Codex Subscription](docs/CODEX_SUBSCRIPTION.md) | Authentication, app-server flow, tools, and thread reuse |
| [Copilot Chat Integration](docs/COPILOT_PATCH.md) | Optional native-controls patch and safeguards |
| [Tokens, Reasoning, and Cache](docs/TOKENS_REASONING_CACHE.md) | Context budgets, reasoning, and cache behavior |
| [Shared Memory](docs/MEMORY.md) | Scopes, retrieval, persistence, and tools |
| [Knowledge Verification](docs/KNOWLEDGE_VERIFICATION.md) | Source policy and cache-stable instructions |
| [Reliability and Diagnostics](docs/RELIABILITY_DIAGNOSTICS.md) | Tool validation, health checks, and reports |
| [Project Audit](docs/AUDIT.md) | Refactoring status, quality gates, and residual risks |

## Development

```sh
npm install
npm run check
npm run package
```

Install the generated VSIX and reload VS Code:

```sh
code --install-extension ./llama-vscode-chat-<version>.vsix --force
```

Useful development commands:

```sh
npm run compile
npm test
npm run patch:copilot:restore
```

## Compatibility and Ownership

The independent extension id is `mrlordcat.llama-vscode-chat`. The
`llamacpp` provider vendor and configuration namespace remain intentionally
stable for existing installations.

The VSIX owns model discovery, routing, prompts, tools, memory, streaming,
context handling, and diagnostics. Official provider runtimes continue to own
their authentication and subscription limits.

## License

[MIT](LICENSE)

## References

- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [VS Code Extension API](https://code.visualstudio.com/api)
