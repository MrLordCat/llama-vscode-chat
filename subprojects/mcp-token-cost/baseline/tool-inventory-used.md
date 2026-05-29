# Used Tools (Migration Candidates)

Source: `subprojects/mcp-token-cost/baseline/tool-inventory.json`

Selection rule:

- `referencedInRequestMessages > 0` OR `observedInStreamToolCalls > 0`

## Current Used Tools

1. `read_file`
   - message references: 16
   - stream tool calls: 2
2. `run_in_terminal`
   - message references: 1
   - stream tool calls: 0

## Note

The full advertised tool catalog is much larger (83 tools) and is listed in:

- `subprojects/mcp-token-cost/baseline/tool-inventory.md`

For API-direct migration prioritization, start from this used-tools list and then broaden by collecting fresh workload logs.
