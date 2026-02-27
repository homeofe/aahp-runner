# aahp-runner: Next Actions for Incoming Agent

> Priority order. Work top-down.
> Each item should be self-contained - the agent must be able to start without asking questions.
> Blocked tasks go to the bottom. Completed tasks move to "Recently Completed".

---

## T-002: Add automated tests

**Goal:** Add unit tests covering core logic (scanner, agent dispatch, tool execution).

**Context:**
- No test framework is currently set up
- Recommend Vitest (fast, ESM-native, zero config for TypeScript)
- Key functions to test: `scanProjects`, `getTopTask`, `buildSystemPrompt`, `executeTool`

**What to do:**
1. Add Vitest as devDependency: `npm install -D vitest`
2. Add `"test": "vitest run"` to `package.json` scripts
3. Create `tests/scanner.test.ts` - test scanProjects with mock fs
4. Create `tests/tools.test.ts` - test executeTool with temp directory
5. Add test step to CI (T-001 should be done first)

**Definition of done:**
- [ ] At least 10 tests written and passing
- [ ] `npm test` exits 0
- [ ] Tests run in CI (after T-001)

---

## T-003: Publish to npm

**Goal:** Publish `aahp-runner` to the npm registry so users can `npm install -g aahp-runner`.

**Context:**
- `package.json` is correctly configured with `"bin"` pointing to `dist/cli.js`
- Need to build before publishing
- Package name `aahp-runner` may or may not be available

**What to do:**
1. Check `npm view aahp-runner` - if taken, use `@homeofe/aahp-runner`
2. Run `npm run build` to ensure dist/ is up to date
3. Run `npm publish` (requires npm login with publish access)
4. Test: `npx aahp-runner --version` from a clean directory

**Definition of done:**
- [ ] Package published to npm
- [ ] `npm install -g aahp-runner` works
- [ ] `aahp --version` prints `0.1.0`

---

## T-004: Add Linux/macOS cron support

**Goal:** The `aahp schedule` command currently only supports Windows Task Scheduler. Add cron support for Linux/macOS.

**Context:**
- `src/scheduler.ts` has `registerWindowsScheduler()` only
- On Linux/macOS, equivalent is `crontab -e`
- Should detect OS and use the right scheduler

**What to do:**
1. In `scheduler.ts`, detect OS: `process.platform === 'win32'`
2. For Linux/macOS: write a cron entry via `crontab -l | { cat; echo "0 2 * * * ..."; } | crontab -`
3. Show the cron string to the user so they can verify
4. Update README with Linux/macOS instructions

**Definition of done:**
- [ ] `aahp schedule --time 02:00` works on Linux/macOS
- [ ] README updated

---

## Recently Completed

| ID | Item | Resolution |
|----|------|-----------|
| - | Initial implementation | CLI, 3 backends, parallel execution, Windows scheduler |
| - | Guided wizard | Step-by-step first-run experience |
| - | Async parallel spawn | Real parallelism via spawn() instead of execSync |
| - | --limit flag | Sliding-window concurrency control |
| - | AAHP handoff files bootstrapped | .ai/handoff/ created (dogfooding) |
| T-001 | GitHub Actions CI pipeline | `.github/workflows/ci.yml` - build on Node 20+22, push/PR to main |

---

## Reference: Key File Locations

| What | Where |
|------|-------|
| CLI entry point | `src/cli.ts` |
| Agent backends | `src/agent.ts` |
| Project scanner | `src/scanner.ts` |
| Windows Scheduler | `src/scheduler.ts` |
| Tool definitions | `src/tools.ts` |
| TypeScript types | `src/types.ts` |
| README | `README.md` |
| Own handoff files | `.ai/handoff/` |
