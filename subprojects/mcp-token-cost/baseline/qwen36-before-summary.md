# Qwen3.6 Before API-Direct Baseline (2026-05-29)

Source log:
- `C:/Users/Chris/AppData/Roaming/Code/User/globalStorage/maruf-bepary.llama-vscode-chat/logs/llamacpp-2026-05-29T07-52-07-565Z-26800.jsonl`

Artifacts:
- `subprojects/mcp-token-cost/baseline/qwen36-before-api-direct.json`
- `subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-before.json`
- `subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-before.md`
- `subprojects/mcp-token-cost/baseline/qwen36-live-snapshot.json`
- `subprojects/mcp-token-cost/baseline/qwen36-live-snapshot.md`

## Baseline Metrics

- completed turns: 49
- avg estimated total tokens/turn: 61729.76
- p95 estimated total tokens/turn: 93341
- avg tokens/sec: 3.9
- p95 duration ms: 132310

## Tool Coverage

- distinct used tools: 33
- coverage gate (`used_tools >= 20`): PASS
- unique advertised tools in requests: 57

Top used tools by signal volume:
1. `read_file` (553)
2. `run_in_terminal` (219)
3. `list_dir` (200)
4. `vscode_listCodeUsages` (164)
5. `grep_search` (122)

## Stability Signals During Run

- `chat.request.transport_error`: 1
- `chat.turn.failed`: 1
- `chat.response.empty_output_with_tool_calls`: 8
- final snapshot reports inFlightTurns: 0

Notes:
- Empty-output events are expected to be partially mitigated by backend helpers and continuation logic.
- Keep this baseline as the canonical "before" for API-direct comparison.

## Priority Work Items (Before -> After)

1. Reduce input token mass by shrinking tool payload overhead in request context.
2. Preserve or improve functional tool parity for the same long-run prompt.
3. Reduce long-tail latency (p95 duration) without increasing failure rate.
4. Track empty-output/failure events and ensure they do not regress after migration.
5. Re-run the exact same benchmark prompt set in a dedicated after folder and compare with `compare-baseline.mjs`.
