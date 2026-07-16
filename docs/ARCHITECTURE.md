# Architecture

## Scope

This extension exposes OpenAI-compatible local models and DeepSeek through one
VS Code language model provider. Stable compatibility ids remain under the
`llamacpp` namespace even though the product name is Local LLM Chat Provider.

## Runtime Components

- `src/extension.ts` is the composition root. It creates services and registers
  the provider, commands, status items, UI providers, and memory tools.
- `src/llama-provider.ts` discovers model sources, resolves routing, prepares
  requests, enforces context budgets, handles compatibility retries, and emits
  metrics.
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
- `src/context/usage.ts` validates upstream token counters and builds the
  fallback statistics forwarded to native Copilot Session Info.
- `src/reasoning.ts` maps VS Code session effort values to local and DeepSeek
  request profiles and supplies the native model configuration schema.
- `src/request/chat-request.ts` builds source-specific OpenAI-compatible request
  bodies without transport or VS Code dependencies.
- `src/transport/request-queue.ts` owns serial request admission, FIFO waiting,
  cancellation, queue timeouts, and idempotent slot release.
- `src/ui/quick-access.ts` owns the grouped Quick Access tree, compact endpoint
  labels, native icons, and live state summaries.
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
5. VS Code messages and tools are converted to OpenAI format.
6. Relevant shared memory is merged into the system context.
7. Tool results are sanitized/truncated and the complete request is budgeted.
8. The serial transport queue grants the request slot.
9. The pure request builder applies local or DeepSeek fields, then the request
   is sent to the source-specific chat completion endpoint.
10. SSE chunks are coalesced and emitted as text, thinking, or tool-call parts.
11. The final upstream usage chunk is validated and emitted as native `usage`
    response data, with an estimate used only when the server omits it.
12. Context overflow, tool-role incompatibility, or empty output can trigger a
   bounded compatibility retry.

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
- Memory content is reference data and cannot override current system/user
  instructions.
- Logs may contain counts, timings, model ids, and tool names, but not API keys
  or raw message bodies.
- Changes to conversion, compaction, streaming, routing, or memory require tests.

## Planned Boundaries

The next refactoring steps should extract these modules from the remaining
provider monolith, in order:

1. `model-sources/`: source configuration, discovery, routing, and caches.
2. `context/`: token estimation and compaction policy (budget arithmetic is
   already extracted).
3. `transport/`: endpoint selection, request execution, and retries (serial
   queueing is already extracted).
4. `ui/`: extract command handlers and status presentation (Quick Access is
   already extracted).

Each extraction should preserve behavior and land with focused tests before the
next boundary moves.
