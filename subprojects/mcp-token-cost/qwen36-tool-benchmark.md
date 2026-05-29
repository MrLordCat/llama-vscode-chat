# Qwen 3.6 Tool Benchmark Plan

Goal: capture reproducible baseline for token usage and execution speed on tool-heavy tasks.

## Preconditions

- Local llama.cpp server is running.
- Qwen 3.6 model is available in provider model list.
- File logging is enabled in extension (`llamacpp.enableFileLogging = true`).
- Stream chunk logging can stay off for normal benchmark runs.

## Benchmark Session Setup

1. Select model: Qwen 3.6 in Copilot model picker.
2. Start a fresh chat session for benchmark run.
3. Execute the tasks below in order.
4. After run, get latest JSONL log path from command `Llama.cpp: Copy Latest Log Path`.

## Benchmark Tasks (Tool-Use Heavy)

Task 1:

- Ask for a code review summary over `src/` and request concrete findings with file references.
- Expected tools: `list_dir`, `grep_search`, `read_file`.

Task 2:

- Ask to implement one small change in existing TypeScript file and run tests.
- Expected tools: `read_file`, edit tool, `run_in_terminal`.

Task 3:

- Ask to investigate a failing behavior via logs and produce root-cause hypothesis.
- Expected tools: `read_file`, `grep_search`, optionally `run_in_terminal`.

Task 4:

- Ask to compare two implementation paths and provide decision with trade-offs.
- Expected tools: `read_file`, `grep_search`.

## Baseline Capture Command

```bash
node subprojects/mcp-token-cost/token-baseline.mjs \
  --input "<LATEST_JSONL_LOG_PATH>" \
  --model-contains "qwen" \
  --output subprojects/mcp-token-cost/baseline/qwen36-before-api-direct.json
```

## Tool Inventory Capture Command

```bash
node subprojects/mcp-token-cost/tool-inventory.mjs \
  --input "<LATEST_JSONL_LOG_PATH>" \
  --output-json subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-before.json \
  --output-md subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-before.md
```

## After API-Direct Migration

Run the exact same benchmark tasks with the same model and capture:

- `qwen36-after-api-direct.json`
- `qwen36-tool-inventory-after.json`

Then compare:

```bash
node subprojects/mcp-token-cost/compare-baseline.mjs \
  --before subprojects/mcp-token-cost/baseline/qwen36-before-api-direct.json \
  --after subprojects/mcp-token-cost/baseline/qwen36-after-api-direct.json
```
