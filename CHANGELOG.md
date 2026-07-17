# Changelog

## 1.1.6 - 2026-07-17

- Disabled Copilot Agent's automatic LLM summarization for local provider
  sessions while preserving the explicit Compact Conversation command.
- Let the provider receive raw host history before enforcing its own exact
  token budget, tool-result sanitization, and deterministic compaction.

## 1.1.5 - 2026-07-17

- Prevented Copilot from reserving its complete raw VS Code tool catalog before
  the local provider applies bounded API Direct tool selection.
- Stopped the resulting early foreground summary and immediate follow-up
  summary loop observed around 41K tokens on a 131K Qwen context.

## 1.1.4 - 2026-07-17

- Prevented Copilot's smaller global summarization threshold from triggering a
  foreground LLM compaction well before a local model's advertised context
  limit.
- Upgraded the guarded Copilot bundle patch to v4 while preserving emergency
  foreground recovery at the real prompt limit.

## 1.1.3 - 2026-07-17

- Prevented Copilot Chat from starting background LLM compaction early for
  extension-contributed local models.
- Made the guarded Copilot patch use the provider's complete context window and
  ignore stale smaller session context overrides for `llamacpp`.
- Added a fast service profile for unavoidable Copilot summaries: no reasoning,
  no memory injection or prompt caching, and a configurable 2048-token cap.
- Added regression coverage for native Copilot compaction prompt detection.

## 1.0.1 - 2026-07-16

- Increased the default local High/Deep reasoning cap from 8192 to 16384
  tokens for complex Qwen coding and agent tasks.
- Kept Light and Balanced at 512 and 2048 tokens.
- Prevented DeepSeek setup from overwriting the local numeric reasoning cap.

## 1.0.0 - 2026-07-16

- Established the independent MrLordCat extension and release workflow.
- Added simultaneous local OpenAI-compatible and DeepSeek model sources.
- Added durable shared memory and native Agent tools.
- Added context budgeting, deterministic compaction, exact usage forwarding,
  prompt-cache diagnostics, and optional native Copilot controls.
- Separated normal output defaults from the global hard ceiling.
- Added llama.cpp-native thinking controls and clarified reasoning semantics.
- Bounded API Direct tool definitions by priority, count, and token cost.
- Extracted source routing, context, request, transport, and UI modules.
- Added CI, tag-based GitHub releases, pinned packaging tools, and 79 tests.
