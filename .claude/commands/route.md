---
description: "Recommend which LLM model and provider to use for a given task"
allowed-tools: "Read"
argument-hint: <task-description>
---

Analyze the task described in: $ARGUMENTS

Read `.llm/ROUTING.md` and `.llm/PROVIDERS.md` for the routing decision matrix.

Then recommend:

1. **Primary model**: The best model for this task and why
2. **Fallback model**: Alternative if primary is unavailable
3. **Cost tier**: Very Low / Low / Medium / High
4. **Estimated tokens**: Rough input/output estimate
5. **MCP tool**: Which akido-mcp tool to use (if applicable)
6. **Subagents**: Whether to use subagents and which types

Format the recommendation as a clear table:

```
| Field | Recommendation |
|-------|---------------|
| Primary | model-name (reason) |
| Fallback | model-name |
| Cost | tier |
| Est. tokens | ~Xk input, ~Yk output |
| MCP tool | tool_name or "native" |
| Subagents | yes/no (which types) |
```

If the task is ambiguous, ask for clarification before recommending.
