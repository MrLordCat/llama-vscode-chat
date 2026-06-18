# Qwen Benchmark Runbook (Separate VS Code Window)

This runbook is designed for llama.cpp VS Code Chat integration.

## Why Separate Window

A separate window isolates benchmark chat history and keeps logs cleaner.

## One-Time Setup

1. Open a new VS Code window at:

  - `subprojects/mcp-token-cost/benchmark-workspace2`

2. Ensure extension settings:

   - `llamacpp.enableFileLogging = true`
   - `llamacpp.logStreamChunks = false`
  - `llamacpp.toolCallingMode = apiDirect`
  - `llamacpp.apiDirectIncludeAllTools = true`
  - `llamacpp.apiDirectMaxTools = 128`

3. In Chat model picker, select Qwen 3.6.

## Per-Run Procedure

1. Start a fresh chat thread.
2. Choose one execution mode:

  - Multi-prompt mode: execute prompts from `PROMPTS.md` in order.
  - Single long-run mode: send one prompt from `LONG_RUN_PROMPT.md`.

3. After all prompts finish, run command:

   - `Llama.cpp: Copy Latest Log Path`

## Live Monitoring (While Model Is Still Running)

Use this command at any time to inspect progress and tool coverage so far:

```bash
node subprojects/mcp-token-cost/live-log-snapshot.mjs \
  --input "<COPIED_JSONL_PATH>" \
  --model-contains "qwen" \
  --output-json subprojects/mcp-token-cost/baseline/qwen36-live-snapshot-after.json \
  --output-md subprojects/mcp-token-cost/baseline/qwen36-live-snapshot-after.md
```

This reports:

- in-flight turns (to see if run is still active)
- error-like records
- distinct used tools so far
- current status of coverage gate (`>= 20`)

When `in-flight turns` reaches `0`, the run is complete and final extraction can start.

## Final Collection (After Run Completes)

You can run the full collection in one command batch:

```bash
LOG="<COPIED_JSONL_PATH>" && \
node subprojects/mcp-token-cost/live-log-snapshot.mjs \
  --input "$LOG" \
  --model-contains "qwen" \
  --output-json subprojects/mcp-token-cost/baseline/qwen36-live-snapshot-after.json \
  --output-md subprojects/mcp-token-cost/baseline/qwen36-live-snapshot-after.md && \
node subprojects/mcp-token-cost/token-baseline.mjs \
  --input "$LOG" \
  --model-contains "qwen" \
  --output subprojects/mcp-token-cost/baseline/qwen36-after-api-direct.json && \
node subprojects/mcp-token-cost/tool-inventory.mjs \
  --input "$LOG" \
  --output-json subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-after.json \
  --output-md subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-after.md
```

4. Paste copied path and run baseline extraction from repository root:

```bash
node subprojects/mcp-token-cost/token-baseline.mjs \
  --input "<COPIED_JSONL_PATH>" \
  --model-contains "qwen" \
  --output subprojects/mcp-token-cost/baseline/qwen36-after-api-direct.json
```

5. Capture tool inventory:

```bash
node subprojects/mcp-token-cost/tool-inventory.mjs \
  --input "<COPIED_JSONL_PATH>" \
  --output-json subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-after.json \
  --output-md subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-after.md
```

6. Count distinct used tools for this run (coverage gate):

```bash
node -e "const fs=require('fs');const p='subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-after.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));const rows=Array.isArray(j.tools)?j.tools:[];const used=rows.filter(t=>(t.referencedInRequestMessages||0)>0||(t.observedInStreamToolCalls||0)>0);console.log('used_tools='+used.length);"
```

Target for long-run benchmark mode: `used_tools >= 20`.

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
4. Long-run mode tool coverage gate passes (`used_tools >= 20`) in before and after runs.
