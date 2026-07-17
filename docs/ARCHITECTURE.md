# Architecture

## Scope

This extension exposes OpenAI-compatible local models and DeepSeek through one
VS Code language model provider. Stable compatibility ids remain under the
`llamacpp` namespace even though the product name is Local LLM Chat Provider.

## Runtime Components

- `src/extension.ts` is the composition root. It creates services and registers
  the provider, commands, status items, UI providers, and memory tools.
- `src/llama-provider.ts` coordinates model discovery, request attempts,
  compatibility retries, streaming, and metrics.
- `src/base-provider.ts` owns provider-independent token estimation and SSE
  streaming/tool-call parsing.
- `src/utils.ts` converts VS Code messages and tools to OpenAI-compatible
  payloads and validates tool-call history.
- `src/logger.ts` writes structured JSONL diagnostics without message bodies or
  authorization headers.
- `src/memory/` owns durable shared memory, retrieval, prompt injection, and
  VS Code language model tools.
- `src/context/context-budget.ts` owns pure soft/hard input budgets and context
  usage estimates shared by initial requests and overflow retries.
- `src/context/copilot-compaction.ts` recognizes Copilot's internal summary
  requests and applies a bounded no-reasoning service profile.
- `src/context/output-budget.ts` separates normal per-source output defaults
  from explicit request limits and the global hard ceiling.
- `src/context/message-compaction.ts` owns deterministic non-mutating history
  compaction with bounded structured summaries of old tool activity.
- `src/context/server-token-counter.ts` owns llama.cpp chat-template application,
  exact tokenization, short-lived count caching, and unsupported-server fallback.
- `src/context/system-prompt.ts` owns the stable knowledge-verification policy,
  custom system instructions, and non-mutating prompt-prefix injection.
- `src/context/tool-result-summary.ts` extracts bounded, non-secret structural
  facts shared by live tool-result truncation and history compaction.
- `src/context/usage.ts` validates upstream token counters and builds the
  fallback statistics forwarded to native Copilot Session Info.
- `src/reasoning.ts` maps VS Code session effort values to local and DeepSeek
  request profiles and supplies the native model configuration schema.
- `src/request/chat-request.ts` builds source-specific OpenAI-compatible request
  bodies without transport or VS Code dependencies.
- `src/model-sources/source-routing.ts` owns source ids, URL deduplication,
  source construction, and model-family routing.
- `src/transport/openai-http.ts` owns endpoint resolution, timeouts,
  cancellation, and serialized HTTP requests.
- `src/transport/request-queue.ts` owns serial request admission, FIFO waiting,
  cancellation, queue timeouts, and idempotent slot release.
- `src/ui/quick-access.ts` owns the grouped Quick Access tree, compact endpoint
  labels, native icons, and live state summaries.
- `src/ui/model-behavior-commands.ts` owns reasoning and tool-mode pickers and
  command handlers.
- `src/constants.ts` contains shared product, provider, endpoint, and limit
  constants.
- `scripts/patch-copilot-chat.mjs` is an opt-in external patcher for Copilot's
  extension-model wrapper. It is development/release tooling, not runtime
  extension code.

`src/vscode.d.ts` is a checked-in VS Code API declaration used for the language
model provider surface. Update it explicitly with `npm run update-vscode-api`.

## Request Flow

1. VS Code asks the provider for available models.
2. The provider discovers primary, dedicated local, and DeepSeek sources and
   returns source-prefixed model ids.
3. For a chat turn, the model id selects the source and credentials.
4. A session-scoped native reasoning selection overrides the global mode when
   Copilot supplies it through `modelOptions`.
5. Internal Copilot compaction prompts are classified before normal request
   tuning so they cannot inherit the user's expensive reasoning profile.
6. VS Code messages and tools are converted to OpenAI format.
7. The stable provider knowledge policy is prepended to native system
   instructions; Copilot compaction service requests skip this policy.
8. Relevant shared memory is inserted immediately before the latest user turn,
   preserving the stable cached prefix.
9. Tool results are sanitized/summarized and the complete local prompt is
   counted with the active server template and tokenizer when available.
10. The serial transport queue grants the request slot.
11. The pure request builder applies local or DeepSeek fields, then the request
   is sent to the source-specific chat completion endpoint.
12. SSE chunks are coalesced and emitted as text, thinking, or tool-call parts.
13. The final upstream usage chunk is validated and emitted as native `usage`
   response data, with an estimate used only when the server omits it.
14. Transient transport failures can retry only before streaming starts;
   context overflow, tool-role incompatibility, or empty output use separate
   bounded recovery paths.

## Persistent Data

- API keys: VS Code `SecretStorage`.
- Shared memory: `<globalStorage>/memory/shared-memory.json`.
- Diagnostics: `<globalStorage>/logs/*.jsonl`.
- User configuration: `llamacpp.*` VS Code settings.

DeepSeek has a dedicated `llamacpp.deepSeekApiKey` secret. The generic primary
server key remains `llamacpp.apiKey`; a legacy fallback keeps older installs
working.

## Invariants

- Source prefixes are never sent as model ids to upstream servers.
- DeepSeek-only fields and llama.cpp-only fields stay source-specific.
- Memory and tool schemas count against the same request budget as messages.
- Exact server counts include the active chat template and tool catalog; the
  heuristic remains mandatory for OpenAI-compatible servers without tokenizer
  endpoints.
- Memory content is reference data and cannot override current system/user
  instructions.
- Knowledge policy and custom durable instructions stay before mutable history;
  source-aware tool descriptions remain stable across turns for cache reuse.
- Logs may contain counts, timings, model ids, and tool names, but not API keys
  or raw message bodies.
- Changes to conversion, compaction, streaming, routing, or memory require tests.

## Remaining Boundaries

The 1.0 refactor established source routing, context, request, transport, and UI
modules with focused tests. The provider intentionally remains the lifecycle
coordinator because streaming retries share turn-local state. Future extraction
should happen only when it produces a smaller stable interface, especially for
model discovery caches or the retry state machine.
