# Changelog

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
