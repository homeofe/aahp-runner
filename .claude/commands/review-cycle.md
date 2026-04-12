---
description: "Run a multi-model review cycle on recent changes"
allowed-tools: "Read, Grep, Glob, Bash(git diff*), Bash(git log*)"
---

Run a multi-model review cycle on recent changes.

## Steps

1. Get the diff of recent changes:
   ```
   git diff HEAD~1 (or appropriate range)
   ```

2. Identify what was changed:
   - Which files were modified
   - What type of changes (new feature, bug fix, refactor)
   - Whether security-sensitive areas were touched

3. Perform local review:
   - Check against `.ai/handoff/CONVENTIONS.md`
   - Look for OWASP Top 10 vulnerabilities
   - Check test coverage
   - Review for edge cases

4. Recommend cross-model review:
   Based on `.llm/ROUTING.md`, suggest which external model should provide a second opinion:
   - Security changes -> suggest Opus or GPT-4 review
   - Performance changes -> suggest Gemini analysis
   - General code -> suggest different provider than implementer

5. If `akido-mcp` tools are available, offer to run:
   - `akido_review_diff` for automated diff review
   - `akido_review_selection` for specific code analysis

## Output

```
=== Review Cycle ===

Changes: [summary]
Files: [list]
Security-sensitive: [yes/no]

Local Review:
- [FINDING] description
- ...

Recommended Cross-Model Review:
- Model: [recommendation]
- Reason: [why this model]
- Tool: [MCP tool to use]

Run cross-model review? (requires user confirmation)
```
