# aahp-runner: Autonomous Multi-Agent Workflow

> Based on the [AAHP Protocol](https://github.com/elvatis/AAHP).
> No manual triggers. Agents read `handoff/DASHBOARD.md` and work autonomously.

---

## Agent Roles

| Agent | Model | Role | Responsibility |
|-------|-------|------|---------------|
| Researcher | perplexity/sonar-pro | Researcher | Research best practices, library choices, API compatibility |
| Architect | claude-opus-4.6 | Architect | System design, interface definitions, test strategy |
| Implementer | claude-opus-4.6 | Implementer | Code, tests, refactoring, commits |
| Reviewer | claude-opus-4.6 / second model | Reviewer | Second opinion, edge cases, security review |

> aahp-runner is a TypeScript/Node.js CLI tool. Most work is code, tests, and CI config.

---

## The Pipeline

### Phase 1: Research & Context

```
Reads:   handoff/NEXT_ACTIONS.md or DASHBOARD.md (top unblocked task)
         handoff/STATUS.md (current project state)

Does:    Researches relevant npm packages, APIs, patterns
         Checks compatibility with existing TypeScript/ESM setup

Writes:  handoff/LOG.md - research findings + recommendation
```

### Phase 2: Architecture Decision

```
Reads:   Research output from LOG.md
         handoff/STATUS.md
         src/types.ts, src/cli.ts (existing interfaces)

Does:    Decides on implementation approach
         Chooses branch name
         Defines exactly what the Implementer should build

Writes:  handoff/LOG.md - ADR (Architecture Decision Record)
```

### Phase 3: Implementation

```
Reads:   ADR from LOG.md
         CONVENTIONS.md (MANDATORY before first commit)

Does:    Creates feature branch
         Writes/modifies TypeScript source in src/
         Runs npm run build to verify compilation
         Runs tests (once T-002 is done)
         Commits and pushes branch

Branch convention:
  feat/<scope>-<short-name>    - new feature
  fix/<scope>-<short-name>     - bug fix
  docs/<scope>-<name>          - documentation only

Commit format:
  feat(scope): description [AAHP-auto]
  fix(scope): description [AAHP-auto]
```

### Phase 4: Discussion Round

```
All agents review the completed work.

Architect  - "Does the implementation match the ADR?"
Reviewer   - "Is it portable? Does it break existing functionality?"
Researcher - "Were all task items fulfilled?"

Outcome:
  - Minor fixes - Implementer fixes in the same branch
  - Larger issues - New tasks added to NEXT_ACTIONS.md / DASHBOARD.md
```

### Phase 5: Completion & Handoff

```
DASHBOARD.md:    Update component status, pipeline state
STATUS.md:       Update changed system state
LOG.md:          Append session summary
NEXT_ACTIONS.md: Check off completed task, add newly discovered tasks
MANIFEST.json:   Run manifest update script or update manually

Git:     Branch pushed, PR-ready
Notify:  Project owner - only on fully completed tasks
```

---

## Autonomy Boundaries

| Allowed | Not allowed |
|---------|-------------|
| Write & commit TypeScript source | Push directly to `main` without approval |
| Write & run tests | Modify package name or version without discussion |
| Push feature branches | Write secrets or PII into any file |
| Research & propose improvements | Break existing CLI commands |
| Make architecture decisions | Delete source files without replacement |

---

## Task Selection Rules

1. Read `DASHBOARD.md`, take the top task where `Ready? = Yes`
2. If a task is **blocked** - skip it, take the next unblocked one
3. If **all tasks are blocked** - notify the project owner, pause
4. Never start a task without reading `STATUS.md` first
5. After completing a task - always update `DASHBOARD.md` before stopping

---

## Error Handling

If an agent fails or is uncertain:
- Mark affected component as `(Unknown)` in `STATUS.md`
- Document the specific blocker in `LOG.md`
- Notify the project owner
- **Never proceed on assumptions when certainty is missing**

---

*This document lives in the repo and is continuously refined by the agents themselves.*
