# Project Audit - Version 1.0.0

## Result

The rapid-prototype codebase has been converted into an independently owned,
tested extension with explicit boundaries for local llama.cpp and DeepSeek.
Version 1.0.0 is the first release where repository metadata, runtime behavior,
documentation, build tooling, and local installation all belong to this fork.

## Completed Work

- Changed publisher, repository, issue tracker, display name, and documentation
  to the independent `MrLordCat` fork while preserving MIT attribution.
- Kept local, primary OpenAI-compatible, and DeepSeek sources available at the
  same time through source-prefixed internal model ids.
- Separated primary and DeepSeek credentials in VS Code SecretStorage.
- Added durable shared memory with retrieval, automatic bounded injection,
  inspectable storage, and confirmed Agent tools.
- Added local and DeepSeek request profiles, exact streamed usage forwarding,
  native context metrics, and the optional guarded Copilot Chat patch.
- Added serial local request admission, bounded compatibility retries, stream
  coalescing, tool-result protection, and structured privacy-conscious logs.

## 1.0 Refactoring

- `src/model-sources/` now owns source construction, URL deduplication, model
  ids, and family routing.
- `src/context/` now owns input budgets, output limits, usage normalization,
  prompt-cache metrics, and non-mutating history compaction.
- `src/request/` owns source-specific request payloads.
- `src/transport/` owns endpoint resolution, HTTP timeout/cancellation, and the
  serial request queue.
- `src/ui/` owns Quick Access and model-behavior command handlers.
- `src/extension.ts` is a smaller composition root; `src/llama-provider.ts`
  remains the turn lifecycle coordinator.

The refactor removed duplicate in-class implementations and reduced the two
largest change hotspots while retaining focused compatibility tests.

## Token And Cache Findings

The audit found and corrected four material efficiency problems:

1. `maxOutputTokensCap` was also used as the default `max_tokens`, causing an
   ordinary DeepSeek turn to reserve as many as 393216 output tokens. Local and
   DeepSeek now have separate normal defaults while the original setting is a
   hard ceiling only.
2. `apiDirectIncludeAllTools=false` behaved the same as `true`. API Direct now
   uses a prioritized 48-tool subset by default and also enforces an approximate
   serialized schema budget.
3. Retrieved memory rewrote the first system message every turn, invalidating
   the reusable llama.cpp prompt prefix. It is now inserted immediately before
   the latest user request.
4. The local numeric reasoning setting used generic fields not consumed by the
   maintained llama.cpp server. Requests now send `thinking_budget_tokens` and
   `chat_template_kwargs.enable_thinking`.

Both llama.cpp `prompt_tokens_details.cached_tokens` and DeepSeek
`prompt_cache_hit_tokens` are normalized, logged, and displayed in Diagnostics.

## Quality Gates

- TypeScript strict compilation.
- ESLint with no current findings.
- 91 VS Code extension-host tests covering routing, context, requests,
  transport, queues, streaming, usage, tools, memory, and UI structure.
- `npm audit` reports no known dependency vulnerabilities after controlled
  test-tool overrides.
- CI runs install, lint, extension-host tests, and VSIX packaging.
- Tags matching `v*` run the same checks and create a GitHub release with the
  packaged VSIX.

## Residual Risks

- Token estimation remains character-based when a server omits exact usage.
- Deterministic compaction is bounded and therefore intentionally lossy, but it
  preserves complete tool turns and code-aware milestones. Model-assisted
  summarization remains omitted by design because it would add generation
  latency, queue contention, cost, and new failure modes.
- Prompt cache reuse depends on server slot policy and exact prefix stability;
  alternating unrelated chats on one slot can still replace the useful cache.
- The Copilot patch targets private bundled code and must be revalidated after
  VS Code or Copilot updates. It remains optional and fail-closed.
- `src/llama-provider.ts` is still large because retries, streaming, and metrics
  share turn-local state. Further splitting should be driven by a concrete
  stable interface, not line count alone.

## Release Decision

The repository is ready for version 1.0.0. Remaining items are future product
improvements rather than unfinished cleanup required for a reliable local and
DeepSeek provider.
