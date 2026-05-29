# Qwen Benchmark Runbook (Separate VS Code Window)

This runbook is designed for llama.cpp VS Code Chat integration.

## Why Separate Window

A separate window isolates benchmark chat history and keeps logs cleaner.

## One-Time Setup

1. Open a new VS Code window at:

   - `subprojects/mcp-token-cost/benchmark-workspace`

2. Ensure extension settings:

   - `llamacpp.enableFileLogging = true`
   - `llamacpp.logStreamChunks = false`

3. In Chat model picker, select Qwen 3.6.

## Per-Run Procedure

1. Start a fresh chat thread.
2. Choose one execution mode:

  - Multi-prompt mode: execute prompts from `PROMPTS.md` in order.
  - Single long-run mode: send one prompt from `LONG_RUN_PROMPT.md`.

3. After all prompts finish, run command:

   - `Llama.cpp: Copy Latest Log Path`

4. Paste copied path and run baseline extraction from repository root:

```bash
node subprojects/mcp-token-cost/token-baseline.mjs \
  --input "<COPIED_JSONL_PATH>" \
  --model-contains "qwen" \
  --output subprojects/mcp-token-cost/baseline/qwen36-before-api-direct.json
```

5. Capture tool inventory:

```bash
node subprojects/mcp-token-cost/tool-inventory.mjs \
  --input "<COPIED_JSONL_PATH>" \
  --output-json subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-before.json \
  --output-md subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-before.md
```

## After API-Direct Migration

Run the same prompts in a new fresh thread, then capture:

- `qwen36-after-api-direct.json`
- `qwen36-tool-inventory-after.json`

Compare:

```bash
node subprojects/mcp-token-cost/compare-baseline.mjs \
  --before subprojects/mcp-token-cost/baseline/qwen36-before-api-direct.json \
  --after subprojects/mcp-token-cost/baseline/qwen36-after-api-direct.json
```

## Acceptance Criteria

1. Lower avg and p95 total tokens per turn.
2. Equal or better tokens/sec median.
3. No functional regressions in prompt outputs.
