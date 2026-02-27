# aahp-runner: Agent Journal

> **Append-only.** Never delete or edit past entries.
> Every agent session adds a new entry at the top.
> This file is the immutable history of decisions and work done.

---

## [2026-02-27] Claude Sonnet 4.6: Bootstrap AAHP handoff files

**Agent:** Claude Sonnet 4.6
**Phase:** setup
**Branch:** main
**Tasks:** (setup - not a task)

### What was done

- Created `.ai/handoff/` directory structure (dogfooding AAHP v3 on aahp-runner itself)
- Created all 8 handoff files: `.aiignore`, `CONVENTIONS.md`, `STATUS.md`, `NEXT_ACTIONS.md`,
  `LOG.md`, `DASHBOARD.md`, `TRUST.md`, `WORKFLOW.md`, `MANIFEST.json`
- Analyzed all source files (`cli.ts`, `agent.ts`, `scanner.ts`, `scheduler.ts`, `tools.ts`, `types.ts`)
  to document the current state accurately
- Identified 4 open tasks: T-001 (CI), T-002 (tests), T-003 (npm publish), T-004 (cron)

### Decisions made

- Used AAHP v3 format matching the AAHP reference project
- Set next_task_id to 5 (T-001 through T-004 defined)
- All 4 open tasks set to `ready` status - no blockers
- Trust: build and CLI verified manually; tests and CI assumed/unknown

---

## [prior sessions] homeofe: Initial aahp-runner implementation

**Agent:** (human + AI assisted)
**Phase:** implementation
**Branch:** main

### What was done

- Created full TypeScript CLI project from scratch
- Implemented 3 agent backends: claude-cli, copilot, sdk
- Added commands: list, run, config, schedule, status
- Added guided wizard (no-args flow)
- Added parallel execution with `--limit` concurrency control
- Added Windows Task Scheduler registration (`aahp schedule`)
- Fixed parallel spawn for real concurrency (async spawn vs execSync)
- Removed em dashes from all source files
- Added live output streaming from agent processes

### Decisions made

- ESM module (`"type": "module"`) for modern Node.js compatibility
- Commander.js for CLI parsing
- chalk + ora for terminal UI
- Backend priority: claude-cli > copilot > sdk (prefer free/auth-based over paid API)
- Config stored in `~/.aahp-runner.json` (not in repo)
- Commit detection: git log since 5 minutes ago (reliable vs string matching)
