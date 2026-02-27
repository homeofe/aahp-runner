# aahp-runner: Build Dashboard

> Single source of truth for build health, test coverage, and pipeline state.
> Updated by agents at the end of every completed task.

---

## Components

| Name | Path | Build | Tests | Status | Notes |
|------|------|-------|-------|--------|-------|
| CLI entry point | `src/cli.ts` | ✅ | manual | ✅ | 5 commands + wizard |
| Agent backends | `src/agent.ts` | ✅ | manual | ✅ | claude-cli, copilot, sdk |
| Project scanner | `src/scanner.ts` | ✅ | manual | ✅ | Reads MANIFEST.json |
| Windows Scheduler | `src/scheduler.ts` | ✅ | manual | ✅ | Task Scheduler + config |
| Tool definitions | `src/tools.ts` | ✅ | manual | ✅ | read/write/list/run/git |
| TypeScript types | `src/types.ts` | ✅ | n/a | ✅ | Interfaces only |
| README | `README.md` | ✅ | n/a | ✅ | Complete |
| CI Pipeline | `src/cli.ts` | ✅ | ✅ | ✅ | `.github/workflows/ci.yml` |
| Test suite | `src/*.test.ts` | ✅ | ✅ 67 | ✅ | 67 Vitest tests

**Legend:** ✅ passing / complete - ❌ failing / missing - ⏳ pending - manual = tested manually only

---

## Test Coverage

| Suite | Tests | Status | Last Run |
|-------|-------|--------|----------|
| Unit tests (Vitest) | 67 | ✅ All passing | 2026-02-27 |
| Build (tsc) | - | ✅ Passes | 2026-02-27 |

**Total: 67 automated tests**

---

## Infrastructure / Deployment

| Component | Status | Blocker |
|-----------|--------|---------|
| GitHub repo | ✅ | - |
| GitHub Actions CI | ✅ Created and running | - |
| npm package | ✅ Published | - |

---

## Pipeline State

| Field | Value |
|-------|-------|
| Current task | All tasks complete |
| Phase | done |
| Last completed | T-004: Add Linux/macOS cron support (2026-02-27) |
| Rate limit | None |

---

## Open Tasks (strategic priority)

| ID | Task | Priority | Depends on | Ready? |
|----|------|----------|-----------|--------|
| - | (no open tasks) | - | - | - |

## Completed Tasks

| ID | Task | Completed |
|----|------|-----------|
| - | Initial implementation | 2026-02-26 |
| - | AAHP handoff files bootstrapped | 2026-02-27 |
| T-001 | Add GitHub Actions CI pipeline | 2026-02-27 |
| T-002 | Add automated tests (67 Vitest tests) | 2026-02-27 |
| T-003 | Publish to npm | 2026-02-27 |
| T-004 | Add Linux/macOS cron support | 2026-02-27 |

---

## Update Instructions (for agents)

After completing any task:

1. Update the relevant row in Open/Completed Tasks
2. Update component status table
3. Update "Pipeline State"
4. Add newly discovered tasks with correct priority and task ID

**Pipeline rules:**
- Blocked task - skip, take next unblocked
- All tasks blocked - notify the project owner
- Notify project owner only on **fully completed tasks**
- Check `depends_on` in MANIFEST.json before starting a task
