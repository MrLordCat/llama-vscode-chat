# Local LLM Chat Provider for VS Code

**One Copilot Chat workflow for local LLMs, DeepSeek, Codex, and Claude subscriptions.**

Local LLM Chat Provider connects multiple model backends to the native VS Code
model picker and Copilot Chat. Local models, remote OpenAI-compatible APIs,
DeepSeek, and subscription-backed Codex and Claude models can coexist in one chat UI and
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
- provide one extensible integration point for future model and subscription providers.

## Model Sources

| Source | Status | Integration |
| --- | --- | --- |
| Local llama.cpp | Available | OpenAI-compatible model discovery and chat completions |
| Other OpenAI-compatible servers | Available | Configurable primary endpoint and API key |
| DeepSeek | Available | Official API, separate credentials, reasoning support |
| OpenAI Codex subscription | Available | Official local `codex app-server` and ChatGPT account |
| Anthropic Claude subscription | Available | Official Claude Agent SDK and signed-in Claude Code runtime |

All enabled sources appear together in the native model picker with labels such
as `(Local)`, `(DeepSeek)`, `(Codex)`, and `(Claude)`. Internal source prefixes route each
request to the correct transport and are never sent to the upstream model.

### Available Model Tiers

| Model | Source | Tier | Tokens | Best For |
| --- | --- | --- | --- | --- |
| **Qwen 3.6 27B** | Local | Free | Unlimited | Narrow verifiable tasks, visual inspection, grep/file reads, terminal output. Always available, no rate limits. |
| **DeepSeek V4 Pro** | DeepSeek API | Budget | API limits | Focused multi-step reasoning, cross-file analysis, architecture review. |
| **GPT-5.6 Luna** | Codex (ChatGPT) | Premium | Subscription | General coding, single-file edits, code review, subagent tasks. Lower token cost than Sol. |
| **GPT-5.6 Terra** | Codex (ChatGPT) | Premium | Subscription | General coding, code generation, refactoring. |
| **GPT-5.6 Sol** | Codex (ChatGPT) | Premium | Subscription | Most powerful Codex model. Repository-wide refactoring, complex implementations. Excluded from subagent use to conserve quota. |
| **Claude Haiku 4.5** | Claude | Premium | Subscription | Fastest Claude model, quick simple tasks. |
| **Claude Sonnet 4.5** | Claude | Premium | Subscription | Best balance of speed and capability. |
| **Claude Opus 4.8** | Claude | Premium | Subscription | Most capable model for complex analysis, security audits, architecture design. |
| **Claude Fable 5** | Claude | Premium | Subscription | Vision-capable coding model. |

**Cost-tier routing for subagents:** prefer Qwen (free/unlimited) for any task it
can handle → DeepSeek for focused reasoning → Codex/Claude subscription models
only for work the cheaper tiers cannot do. Premium models consume limited
subscription budget — escalate only when genuinely necessary.

Custom global agents for each model are available in `~/.copilot/agents/`,
providing tailored instructions and tool configurations per model.

## Key Features

### Unified Copilot Chat Flow

- Multiple model sources remain enabled at the same time.
- Model selection stays in the native Copilot Chat picker.
- Local and API credentials are isolated in VS Code SecretStorage.
- Subscription authentication remains owned by the official Codex and Claude
  runtimes; this extension does not read or copy their credential files.

### Efficient Tools and Agent Execution

- Models select from Copilot's current outer tool catalog.
- Commands, files, searches, web access, memory, and private caller tools are
  executed by Copilot with native cards and the current approval mode.
- Large catalogs use deferred schema loading so uncommon tools do not occupy
  every prompt.
- Parallel Codex tool calls are returned as one native batch.
- Codex and Claude built-in action tools are disabled. Commands, edits, web
  access, and every other action must return through native VS Code tool cards.
- Late Codex tool calls that arrive between result rounds are queued for the
  next native segment instead of failing during the bridge hand-off.
- Tool names and arguments are repaired only when deterministic, validated
  against advertised schemas, and protected from repeated-call loops.

### Context and Cache Efficiency

- Context budgets include messages, tool schemas, memory, and reply reserve.
- Large tool results are sanitized, summarized, and bounded.
- Long histories are compacted without leaving orphaned tool calls.
- llama.cpp can use exact `/apply-template` and `/tokenize` prompt counts.
- Stable prompt prefixes and late memory injection improve local/DeepSeek cache
  reuse.
- Diagnostics distinguish cached tokens in the current prompt from retention
  of the previous prompt prefix; a moderate current cache percentage can still
  coexist with near-complete reuse of the preceding prefix.
- Codex tool-result rounds continue the same app-server turn.
- Completed Codex threads can be reused for ordinary follow-ups, sending only
  incremental input instead of the full Copilot conversation.
- Claude conversations reuse warm Agent SDK sessions and resume native tool
  results without rebuilding the complete session.

### Reasoning, Streaming, and Reliability

- Native thinking/reasoning is separated from visible answer text.
- Local and DeepSeek request profiles keep provider-specific fields isolated.
- Stream chunks are coalesced to reduce UI pressure during long answers.
- Cancellation stops upstream generation and releases local server capacity.
- Codex fails closed if its runtime attempts an internal shell, file, web,
  MCP, browser, plugin, or subagent action outside the VS Code tool loop.
- Transient failures, context overflow, incompatible tool-result roles, and
  empty output have separate bounded recovery paths.
- Exact upstream usage is forwarded to Copilot Session Info when available.

### Memory and Diagnostics

- Scoped shared memory supports typed entries, provenance, expiry, retrieval,
  automatic bounded injection, and native Agent tools.
- Quick Access groups connections, model behavior, memory, and diagnostics.
- Health checks, session-quality reports, context usage, current-prompt cache
  coverage, previous-prefix retention, throughput, and warm session/thread
  reuse are visible without logging prompt bodies.
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

### Claude Subscription

1. Install the official Anthropic Claude Code VS Code extension or make the
  Claude Code CLI available on `PATH`.
2. Sign in through Claude Code, or run `Local LLM: Sign In to Claude Subscription`.
3. Refresh models and select a model labelled `(Claude)`.

Claude runs through the official Agent SDK. Built-in Claude Code tools and
external MCP servers are excluded; only tools hosted by the native VS Code
bridge are allowed.

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
| `Local LLM: Sign In to Claude Subscription` | Authenticate the Claude Code runtime |
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
| [Agent Tools Guide](docs/AGENT_TOOLS_GUIDE.md) | Compact CLI workflows for efficient agent sessions |
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

The VSIX owns model discovery, routing, prompts, native tool delegation,
memory, streaming, context handling, and diagnostics. Official provider
runtimes continue to own their authentication and subscription limits.

## License

[MIT](LICENSE)

## References

- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [VS Code Extension API](https://code.visualstudio.com/api)
