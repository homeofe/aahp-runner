# NEXT_ACTIONS - aahp-runner

> Priority order. Work top-down.
> Each item is self-contained - agent can start without asking questions.

---

## T-010: Merge Dependabot PRs and Fix Security Alerts

**Goal:** Merge 4 open Dependabot PRs and resolve 3 security alerts (vite).

**Context:**
- 4 open PRs: vite 8.0.3->8.0.5 (#17), @anthropic-ai/sdk 0.36->0.82 (#16), @types/node 25.5.0->25.5.2 (#15), typescript 5.9.3->6.0.2 (#14)
- 3 Dependabot security alerts: all vite-related (2 high, 1 medium)
- Merging PR #17 (vite bump) should resolve all 3 security alerts

**What to do:**
1. Review each PR for breaking changes (especially @anthropic-ai/sdk 0.36->0.82 and typescript 5.9->6.0)
2. Merge PRs in order: #15 (@types/node - safe), #17 (vite - fixes security), #14 (typescript), #16 (sdk - check API changes)
3. After merge: `npm install && npm run build && npm test`
4. If @anthropic-ai/sdk 0.82 has breaking changes, fix them in `src/agent.ts`
5. If typescript 6.0 introduces new errors, fix them
6. Verify all 3 Dependabot security alerts auto-close after vite merge
7. Commit any fixes needed

**Definition of done:**
- [ ] All 4 Dependabot PRs merged
- [ ] All 3 security alerts resolved
- [ ] `npm run build` passes
- [ ] `npm test` passes (160 tests)
- [ ] No new security alerts

---

## T-011: Run Tests After Scanner Bug Fixes

**Goal:** Verify all 160 tests still pass after the scanner.ts and cli.ts changes from 2026-04-12.

**Context:**
- Scanner.ts changed: added null guards on Object.values(tasks) and Object.entries(tasks)
- CLI.ts changed: removed DEFAULT_ROOT from Commander options, added optional chaining on last_session
- Changes were deployed live but tests not re-run

**What to do:**
1. `npm test` - run all vitest tests
2. Fix any failures caused by the changes
3. If tests pass, update TRUST.md to mark "Tests pass" as verified

**Definition of done:**
- [ ] `npm test` runs all 160 tests
- [ ] All tests pass (or failures fixed)
- [ ] TRUST.md updated

---

## T-012: Publish v0.2.0 to npm

**Goal:** Bump version and publish to npm registry.

**Context:**
- v0.1.0 was published but not available (E404 from npm)
- Many features added since v0.1.0: status --quick, archive, retry, dry-run, metrics
- Bug fixes: null task guards, config root override

**What to do:**
1. Bump version in package.json to 0.2.0
2. Ensure all tests pass
3. `npm publish` (or `npm publish --access public` if scoped)
4. Verify installation: `npm install -g aahp-runner && aahp --version`

**Definition of done:**
- [ ] package.json version is 0.2.0
- [ ] `npm publish` succeeds
- [ ] `npm install -g aahp-runner` works from npm registry

---

## Recently Completed

| ID | Task | Resolution |
|----|------|-----------|
| T-009 | Add --dry-run flag | Implemented, 160 tests passing |
| T-008 | Retry logic with exponential backoff | withRetry exported from agent.ts |
| T-007 | Agent execution tests | 30 tests in agent.test.ts |
| T-006 | Archive command | LOG.md rotation with --keep N |
| T-005 | Status --quick | Per-project task breakdown |
| Bug fix | Scanner null guards | Object.values/entries null filtering |
| Bug fix | Config root override | Commander default removed |
| Integration | AI Workflow Framework | .claude/, .llm/ added |

---

## Reference

| What | Where |
|------|-------|
| CLI entry point | `src/cli.ts` |
| Agent backends | `src/agent.ts` |
| Scanner | `src/scanner.ts` |
| Tests | `src/*.test.ts` |
| GitHub PRs | `gh pr list --repo homeofe/aahp-runner` |
| Security alerts | `gh api repos/homeofe/aahp-runner/dependabot/alerts` |
