# Project Audit - 2026-07-16

## Outcome

The repository has a solid functional core and unusually good coverage of
provider compatibility edge cases, but rapid feature work concentrated too many
responsibilities in `llama-provider.ts` and `extension.ts`. This audit begins a
staged refactor without rewriting stable streaming or tool behavior.

Completed in the first cleanup pass:

- changed extension ownership metadata to `MrLordCat` and the fork repository;
- preserved original MIT attribution and added current ownership;
- added a separate shared-memory subsystem with persistence, retrieval, prompt
  injection, Agent mode tools, commands, limits, and tests;
- separated DeepSeek and primary-server credentials with a legacy fallback;
- centralized shared ids, endpoints, and limits;
- removed the inactive Hugging Face provider, a duplicate API declaration, and
  a committed runtime log;
- removed network downloads from `postinstall` and made VS Code API refresh an
  explicit development command;
- isolated VS Code test profiles by Windows username;
- documented runtime architecture and durable memory.

Completed in the second cleanup pass:

- extracted reasoning mode normalization and request-level overrides;
- extracted context budget/usage arithmetic with focused tests;
- added native model configuration metadata for Thinking Effort;
- added a guarded, reversible Copilot Chat patcher for extension-provided model
  controls and output limits.
- extracted and reorganized Quick Access into compact native tree groups with
  view-title actions and structure tests.

Completed in the third integration pass:

- requested exact streamed token usage from llama.cpp and DeepSeek;
- forwarded validated usage to Copilot's native Session Info with an estimate
  fallback for compatible servers that omit counters;
- documented the complete fork scope and the ownership boundary between the
  normal VSIX and optional Copilot Chat bundle modifications.

## Findings

### High Priority

1. `src/llama-provider.ts` remains a large change hotspot. Discovery, routing,
   caching, budgeting, request profiles, queueing, retry policy, and telemetry
   should move behind narrow modules.
2. `src/extension.ts` still mixes composition, status presentation, and every
   command handler. Quick Access is extracted; command handlers should follow
   after provider boundaries stabilize.
3. Most model settings are global even though local models and DeepSeek have
   different optimal reasoning, output, timeout, and tool policies. Introduce
   source profiles before adding another hosted provider.
4. Compaction is deterministic but lossy and heuristic. It clips old turns and
   tool payloads instead of producing a model-assisted semantic summary. Keep
   the deterministic fallback, then add an optional tested summarizer.

### Medium Priority

1. HTTP behavior is tested through patched private methods and global `fetch`.
   Inject a transport interface so discovery, retries, cancellation, and error
   parsing can be unit tested directly.
2. Token counts use a character heuristic. Add optional server/tokenizer-backed
   counting with the current estimator as a fast fallback.
3. There is no CI workflow. Add compile, lint, tests, manifest validation, and
   VSIX packaging on supported Windows/Linux runners.
4. Packaging relies on an on-demand `npx @vscode/vsce`. Pin `@vscode/vsce` as a
   development dependency when the Node toolchain is normalized.
5. The benchmark corpus under `subprojects/mcp-token-cost` is useful but large.
   Keep it dev-only and publish summarized conclusions in normal docs.

### Low Priority

1. Naming still contains `llamacpp` for compatibility. User-facing labels can
   migrate to Local LLM while command ids and settings remain stable.
2. Source formatting mixes tabs and spaces in older files. Apply formatting
   only after large classes are split to avoid an unreadable full-file diff.
3. Some comments repeat the code or reference older single-source behavior.
   Clean them as their owning modules are extracted.

## Refactoring Sequence

1. Extract model source discovery and source-specific credentials.
2. Extract the remaining context compaction policy (budget arithmetic is done).
3. Extract request payload builders for local and DeepSeek profiles.
4. Extract transport queue and retry state machine.
5. Split extension commands and status presentation (Quick Access is done).
6. Add CI and release automation.

The rule for each phase is behavior-preserving extraction first, then targeted
improvements. The full provider test suite must remain green after every phase.
