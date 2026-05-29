# Single Long-Run Prompt (Qwen 3.6)

Copy and send the prompt below as one message in a fresh chat thread.

---

You are running a single long benchmark task. Work autonomously and complete all steps in one run.

Requirements:
- Use tools when needed.
- Keep outputs concise but complete.
- Use file references for concrete findings.
- Do not ask follow-up questions unless blocked.

Task:
1. Scan this workspace and identify:
   - 5 most important source files
   - 3 architectural risks
   - 3 quick wins
2. Pick one low-risk TypeScript improvement and implement it.
3. Run tests and report pass/fail summary.
4. Analyze available logs for instability and provide:
   - top 3 likely root causes
   - evidence for each cause
   - one mitigation per cause
5. Propose two options to reduce token cost in tool workflows.
   For each option include:
   - expected token impact
   - implementation complexity
   - risks
   Then choose one option and justify.
6. Produce a phased migration plan to reduce tool-related token usage with:
   - milestones
   - measurable KPIs
   - rollback criteria
7. End with a compact final report with these sections:
   - Changes made
   - Test result
   - Risks
   - Recommended next step

Important benchmark behavior:
- Try to finish in one continuous run.
- Avoid unnecessary repeated scans of the same files.
- Prefer targeted tool calls over broad repeated searches.

---
