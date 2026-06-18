# Single Long-Run Prompt (Qwen 3.6)

Copy and send the prompt below as one message in a fresh chat thread.

---

You are running a single long benchmark task. Work autonomously and complete all steps in one run.

Primary benchmark goal:
- Use a broad tool mix and reach at least 20 distinct tools used during execution (if available in this environment).

Global rules:
- Use tools directly; do not simulate tool usage.
- Keep outputs concise but complete.
- Include file references for concrete findings.
- Do not ask follow-up questions unless blocked.
- Finish in one continuous run.

Tool-coverage rules:
- Use multiple tool families: file discovery, content search, semantic search, code usage analysis, diagnostics, edits, terminal commands, and git/status checks.
- Avoid repeatedly using the same 2-3 tools for all steps.
- At the end, include a "Tool Usage Summary" table listing each tool name and why it was used.

Task:
1. Workspace mapping
   - Build a map of project structure and identify:
     - 8 most important files
     - 4 architectural risks
     - 4 quick wins
2. Multi-method code analysis
   - Use at least 3 different search/analysis approaches (for example lexical search, semantic search, and symbol/reference lookup).
   - Cross-check findings between methods and call out mismatches.
3. Diagnostics and quality checks
   - Collect current compile/lint/test diagnostics.
   - Identify top 5 actionable issues by severity and impact.
4. Safe implementation
   - Pick one low-risk TypeScript improvement and implement it.
   - Validate via tests or targeted verification command.
5. Runtime and log investigation
   - Analyze available logs for instability patterns.
   - Provide top 3 likely root causes, evidence, and one mitigation each.
6. Token-cost optimization decision
   - Propose two options to reduce tool-related token cost.
   - For each option provide expected token impact, complexity, and risks.
   - Choose one option and justify.
7. Migration plan
   - Produce a phased API-direct migration plan with milestones, measurable KPIs, and rollback criteria.
8. Final report
   - Changes made
   - Verification/test result
   - Risks and regressions
   - Recommended next step
   - Tool Usage Summary (tool name, purpose, count)

Success target for this run:
- At least 20 distinct tools used, with meaningful usage across multiple tool families.

---
