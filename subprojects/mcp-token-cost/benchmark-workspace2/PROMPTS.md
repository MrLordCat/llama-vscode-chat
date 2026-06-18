# Benchmark Prompts (Use As-Is)

Use these prompts in order in a fresh chat thread with Qwen 3.6 selected.

## Alternative: Single Long-Run Mode

If you want one-message benchmark execution, use:

- `LONG_RUN_PROMPT.md`

Send it as one prompt in a fresh chat thread.

## Prompt 1: Repository Scan

Perform a concise codebase scan of this workspace and list:
- 5 most important source files
- 3 architectural risks
- 3 quick wins
Use tools where needed and include file references.

## Prompt 2: Implement Small Change

Find one low-risk improvement in TypeScript code, implement it, and explain why it is safe. Then run tests and report result.

## Prompt 3: Log Analysis

Analyze available logs for failures or instability patterns. Provide:
- top 3 likely root causes
- evidence for each cause
- one concrete mitigation per cause

## Prompt 4: Trade-Off Decision

Propose two implementation options for reducing token cost in tool workflows.
For each option provide:
- expected token impact
- implementation complexity
- risks
Then pick one option and justify the choice.

## Prompt 5: Refactor Plan

Create a phased migration plan to reduce tool-related token consumption.
Include milestones, measurable KPIs, and rollback criteria.
