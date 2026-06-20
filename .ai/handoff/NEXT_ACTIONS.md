# NEXT_ACTIONS - aahp-runner

> Priority order. Work top-down.
> Each item is self-contained - agent can start without asking questions.

---

## Active Tasks

### T-013: - Capture LLM token totals in RunMetric (issue #27)

> **Status:** in_progress (PR #29 open, awaiting review)
> **Priority:** medium
> **GitHub:** issue #27 / PR #29
> **Branch:** feat/issue-27-token-metrics
> **Unblocks:** aahp-hub T-005

Done when PR #29 is merged and main is on a tagged release that includes
the new fields. The hub picks them up automatically once the version is
on npm.

### T-014: - HTTP /abort endpoint for running agents (issue #28)

> **Status:** in_progress (PR #30 open, awaiting review)
> **Priority:** high
> **GitHub:** issue #28 / PR #30
> **Branch:** feat/issue-28-abort-endpoint
> **Unblocks:** aahp-hub T-004

Done when PR #30 is merged and main is on a tagged release. Smoke test
checklist is in the PR body.

---

## Potential Future Work (not yet formal tasks)

| Area | Suggestion | Why |
|------|-----------|-----|
| Token usage for CLI backends | Parse summary-line token counts from claude-cli, gemini, codex output | T-013 wires SDK + Copilot only; CLIs print token counts but each format differs |
| Abort in `aahp overnight` | Wire `startControlServer` into `aahp overnight` cycle | T-014 covers `aahp run` only; overnight is a separate command |
| Token cost calculation | Hub-side: derive cost from modelId + token counts | Belongs in aahp-hub but needs runner to ship modelId in metrics first (T-013 does this) |
| GitHub Actions | Bump actions/checkout and setup-node to Node 24 variants | Node 20 deprecated in CI runners by Sep 2026 |
| Dependabot bumps | Merge open #24 (sdk 0.91.1), #25 (vitest 4.1.5), #26 (ora 9.4.0) | Out of scope for this session; routine maintenance |

---

## Recently Completed

| ID | Task | Resolution |
|----|------|-----------|
| T-012 | Publish v0.2.0 to npm | Published as @elvatis_com/aahp-runner via GitHub Actions release trigger |
| T-011 | Run tests after scanner bug fixes | 174 tests passing under TypeScript 6.0 |
| T-010 | Merge Dependabot PRs and fix security alerts | All 4 PRs merged; 5 security alerts resolved |
| T-009 | Add --dry-run flag to aahp run | Implemented |
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
| Control server (PR #30) | `src/control-server.ts` |
| Metrics store | `src/metrics-store.ts` |
| Scanner | `src/scanner.ts` |
| Tests | `src/*.test.ts` |
| npm package | `@elvatis_com/aahp-runner` |
| GitHub releases | `gh release list --repo homeofe/aahp-runner` |
| Sister hub repo | https://github.com/homeofe/aahp-hub |
