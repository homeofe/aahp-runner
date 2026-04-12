# NEXT_ACTIONS - aahp-runner

> Priority order. Work top-down.
> Each item is self-contained - agent can start without asking questions.

---

## Active Tasks

None. All 12 tasks are complete. No blockers. Project is in a clean, published state.

Next session should identify new tasks via planning or user-defined requirements.

---

## Potential Future Work (not yet formal tasks)

| Area | Suggestion | Why |
|------|-----------|-----|
| GitHub Actions | Bump actions/checkout and setup-node to Node 24 variants | Node 20 deprecated in CI runners by Sep 2026 |
| VS Code extension | Review vscode-extension/ for compatibility with new deps | Not reviewed since initial session |
| Test coverage | Add integration tests for --dry-run and archive commands | Currently only unit-tested |
| Documentation | Add CHANGELOG.md | No formal changelog tracking releases |

---

## Recently Completed

| ID | Task | Resolution |
|----|------|-----------|
| T-012 | Publish v0.2.0 to npm | Published as @elvatis_com/aahp-runner via GitHub Actions release trigger |
| T-011 | Run tests after scanner bug fixes | 174 tests passing (11 suites) under TypeScript 6.0 |
| T-010 | Merge Dependabot PRs and fix security alerts | All 4 PRs merged; all 5 security alerts resolved; node-fetch removed |
| T-009 | Add --dry-run flag to aahp run | Implemented, prior session |
| T-008 | Retry logic with exponential backoff | withRetry exported from agent.ts |
| T-007 | Agent execution tests | 30 tests in agent.test.ts |
| T-006 | Archive command | LOG.md rotation with --keep N |
| T-005 | Status --quick | Per-project task breakdown |

---

## Reference

| What | Where |
|------|-------|
| CLI entry point | `src/cli.ts` |
| Agent backends | `src/agent.ts` |
| Scanner | `src/scanner.ts` |
| Tests | `src/*.test.ts` |
| npm package | `@elvatis_com/aahp-runner` |
| GitHub releases | `gh release list --repo homeofe/aahp-runner` |
