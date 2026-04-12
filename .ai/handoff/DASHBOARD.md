# aahp-runner: Build Dashboard

> Single source of truth for build health, test coverage, and pipeline state.
> Updated by agents at the end of every completed task.

---

## Components

| Name | Path | Build | Tests | Status | Notes |
|------|------|-------|-------|--------|-------|
| CLI entry point | `src/cli.ts` | ✅ | ✅ | ✅ | 11 commands + wizard + --dry-run |
| Agent backends | `src/agent.ts` | ✅ | ✅ | ✅ | claude-cli, copilot, sdk + retry; node-fetch removed |
| Project scanner | `src/scanner.ts` | ✅ | ✅ | ✅ | Null task guards, config root fix |
| Scheduler | `src/scheduler.ts` | ✅ | ✅ | ✅ | cron + Task Scheduler |
| Tool definitions | `src/tools.ts` | ✅ | ✅ | ✅ | 6 tools for Claude tool_use |
| Status board | `src/status-board.ts` | ✅ | ✅ | ✅ | Live terminal display |
| Metrics store | `src/metrics-store.ts` | ✅ | ✅ | ✅ | JSONL persistence |
| Resource monitor | `src/resource-monitor.ts` | ✅ | ✅ | ✅ | CPU/memory tracking |
| Alerting | `src/alerting.ts` | ✅ | ✅ | ✅ | Webhook/Slack |
| TypeScript types | `src/types.ts` | ✅ | n/a | ✅ | Interfaces only |
| VS Code extension | `vscode-extension/` | ⏳ | ⏳ | ⏳ | Not reviewed |

**Legend:** ✅ passing / complete - ❌ failing / missing - ⏳ pending - manual = tested manually only

---

## Test Coverage

| Suite | Tests | Status | Last Run |
|-------|-------|--------|----------|
| Unit tests (Vitest) | 174 | ✅ All passing | 2026-04-12 |
| Build (tsc) | - | ✅ Passes (TypeScript 6.0) | 2026-04-12 |

**Total: 174 automated tests across 11 suites**

---

## Security

| Alert | Severity | Status |
|-------|----------|--------|
| vite: server.fs.deny bypass | HIGH | ✅ Fixed (vite 8.0.5) |
| vite: arbitrary file read via WebSocket | HIGH | ✅ Fixed (vite 8.0.5) |
| vite: path traversal in .map handling | MEDIUM | ✅ Fixed (vite 8.0.5) |
| picomatch: ReDoS extglob | HIGH | ✅ Fixed (prior session) |
| picomatch: method injection | MEDIUM | ✅ Fixed (prior session) |

---

## Infrastructure / Deployment

| Component | Status | Notes |
|-----------|--------|-------|
| GitHub repo | ✅ | homeofe/aahp-runner |
| GitHub Actions CI | ✅ | Node 20+22 matrix |
| GitHub Actions autopublish | ✅ | Triggers on release published |
| npm package | ✅ v0.2.0 | @elvatis_com/aahp-runner |
| GitHub release | ✅ v0.2.0 | Created 2026-04-12 |

---

## Pipeline State

| Field | Value |
|-------|-------|
| Current task | None - all tasks complete |
| Phase | done |
| Last completed | T-012: Publish v0.2.0 to npm (2026-04-12) |
| Next session | Identify new tasks or maintenance |

---

## Open Tasks

| ID | Task | Priority | Depends on | Ready? |
|----|------|----------|-----------|--------|
| - | (no open tasks) | - | - | - |

## Completed Tasks

| ID | Task | Completed |
|----|------|-----------|
| T-012 | Publish v0.2.0 to npm | 2026-04-12 |
| T-011 | Run tests after scanner bug fixes | 2026-04-12 |
| T-010 | Merge Dependabot PRs + fix security alerts | 2026-04-12 |
| T-009 | Add --dry-run flag to aahp run | 2026-04-12 |
| T-008 | Retry logic with exponential backoff | 2026-03-19 |
| T-007 | Add agent execution tests | 2026-03-19 |
| T-006 | Archive command (LOG.md rotation) | 2026-03-19 |
| T-005 | Status --quick command | 2026-03-19 |
| T-004 | Add Linux/macOS cron support | 2026-02-27 |
| T-003 | Publish to npm (v0.1.0) | 2026-02-27 |
| T-002 | Add automated tests (Vitest) | 2026-02-27 |
| T-001 | Add GitHub Actions CI pipeline | 2026-02-27 |

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
