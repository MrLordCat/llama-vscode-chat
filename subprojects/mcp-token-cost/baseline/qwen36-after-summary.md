# Qwen3.6 After API-Direct Baseline (2026-05-29)

Source log:
- `C:/Users/Chris/AppData/Roaming/Code/User/globalStorage/maruf-bepary.llama-vscode-chat/logs/llamacpp-2026-05-29T09-58-01-411Z-7732.jsonl`

Artifacts:
- `subprojects/mcp-token-cost/baseline/qwen36-after-api-direct.json`
- `subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-after.json`
- `subprojects/mcp-token-cost/baseline/qwen36-tool-inventory-after.md`
- `subprojects/mcp-token-cost/baseline/qwen36-live-snapshot-after.json`
- `subprojects/mcp-token-cost/baseline/qwen36-live-snapshot-after.md`

## Core Metrics

- completed turns: 44
- avg estimated total tokens/turn: 41089.25
- p95 estimated total tokens/turn: 68534
- avg tokens/sec: 6.05
- p95 duration ms: 253559

## Tool Coverage

- distinct used tools: 26
- coverage gate (`used_tools >= 20`): PASS
- unique advertised tools in requests: 55

Top used tools by signal volume:
1. `read_file` (276)
2. `create_directory` (135)
3. `vscode_listCodeUsages` (110)
4. `run_in_terminal` (98)
5. `file_search` (88)

## Stability Signals

- `chat.request.transport_error`: 0
- `chat.turn.failed`: 0
- `chat.response.empty_output_with_tool_calls`: 7
- final snapshot reports inFlightTurns: 0

## Before vs After Highlights

- avg total tokens/turn: 61729.76 -> 41089.25 (`-33.44%`)
- p95 total tokens/turn: 93341 -> 68534 (`-26.58%`)
- avg input tokens/turn: 61633.8 -> 40893.52 (`-33.65%`)
- avg tokens/sec: 3.9 -> 6.05 (`+55.13%`)
- median tokens/sec: 2.76 -> 4.24 (`+53.62%`)
- p95 duration ms: 132310 -> 253559 (`+91.64%`)

## Tool-Parity Notes

Used-tool set changed from 33 -> 26.

Dropped in this run:
- `click_element`
- `copilot_getNotebookSummary`
- `create_and_run_task`
- `fetch_webpage`
- `get_terminal_output`
- `github_repo`
- `github_text_search`
- `hover_element`
- `navigate_page`
- `open_browser_page`
- `read_page`
- `screenshot_page`
- `testFailure`
- `vscode_askQuestions`

Added in this run:
- `configure_python_environment`
- `create_directory`
- `create_new_jupyter_notebook`
- `create_new_workspace`
- `get_python_environment_details`
- `get_python_executable_details`
- `run_vscode_command`
