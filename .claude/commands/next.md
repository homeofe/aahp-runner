---
description: "Pick and start the next ready AAHP task from the task graph"
allowed-tools: "Read, Edit, Write"
---

Read the AAHP task graph and start the next ready task.

## Steps

1. Read `.ai/handoff/MANIFEST.json`
2. Filter tasks where `status = "ready"`
3. For each ready task, verify all `depends_on` tasks have `status = "done"`
4. Sort eligible tasks by priority: critical > high > medium > low
5. Display the top task with full context
6. Read `.ai/handoff/NEXT_ACTIONS.md` for detailed instructions

## Output

```
=== Next Task ===

[T-XXX]: [title]
Priority: [priority]
Dependencies: [all met / list]

Instructions:
[from NEXT_ACTIONS.md]

Ready to start? Set status to "in_progress" and begin work.
```

If all tasks are blocked:
- List the blockers
- Suggest notifying the project owner
- Do NOT start any blocked task

If no tasks exist:
- Suggest creating new tasks based on STATUS.md gaps
