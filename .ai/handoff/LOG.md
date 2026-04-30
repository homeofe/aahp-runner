# aahp-runner: Agent Journal

> **Append-only.** Never delete or edit past entries.
> Every agent session adds a new entry at the top.
> This file is the immutable history of decisions and work done.

---

## [2026-04-27] Claude Opus 4.7: T-013 + T-014 (issues #27 #28)

> **Agent:** claude-opus-4-7
> **Session ID:** T-013-T-014-2026-04-27
> **Timestamp:** 2026-04-27T13:55:00.000Z
> **Commit before:** 5040492 (fix(logs): aahp logs reads rootDir from config)
> **PRs opened:** #29 (issue #27), #30 (issue #28)

**What was done:**

- T-013 (issue #27 - token totals in RunMetric): Extended `RunMetric` and `AgentResult` with optional fields `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `modelId`. Wired the SDK backend to accumulate `response.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` across turns. Wired the Copilot backend to accumulate `data.usage.{prompt_tokens, completion_tokens}` from the OpenAI-compatible response. CLI backends (claude-cli, gemini, codex) leave the fields undefined for now - issue notes this as a follow-up. All 8 `recordMetric` callsites in `cli.ts` thread the new fields. Added 5 new tests in `metrics-store.test.ts` covering full population, backwards compat with pre-#27 lines, partial data (Copilot has no cache), mixed-format JSONL, and zero-valued counts. 195 tests passing on PR #29 branch.
- T-014 (issue #28 - abort endpoint): New module `src/control-server.ts` exposing `startControlServer({ sessionsFile? })`. HTTP server bound to `127.0.0.1:0` (random port) accepting `POST /abort` with `{ repoName, taskId }`; returns 200/404/400/405/413 as appropriate. Body capped at 4KB. Port written to `~/.aahp/sessions.json` under top-level `controlPort` (sibling to `sessions`); read-modify-write merge preserves the orchestrator's existing keys. Added `aborted?: boolean` to `AgentResult` and `RunMetric`. Threaded optional `abortSignal: AbortSignal` through `runAgent` and every backend: SDK forwards `{ signal }` to `messages.create()`; Copilot chains the external signal into the in-flight fetch's per-request AbortController; CLI backends register a `SIGTERM` handler that escalates to `SIGKILL` after 5s. Wired lifecycle into `aahp run` parallel and sequential paths; each agent gets its own AbortController, registered in a try/finally block. 19 new tests in `src/control-server.test.ts` covering port assignment, sessions.json merge/cleanup, registry, all HTTP status codes, multi-agent routing, port release after stop, and idempotent stop. 209 tests passing on PR #30 branch.

**Decisions made:**

- Two separate PRs (not one combined commit) per the operator brief. #27 is purely additive metrics fields; #28 introduces a new module and a new optional parameter. Splitting makes review easier and lets the hub-side T-005 land independently of T-004.
- For `aborted` semantics: a run with `aborted=true` is recorded as `success=false` regardless of whether a commit landed mid-flight. `committed` reports the actual git state. The hub can therefore distinguish "user aborted us" (aborted=true) from "agent ran and failed" (success=false, aborted=undefined).
- Sessions.json merge strategy: read-modify-write rather than overwrite. The orchestrator and the runner both write this file; clobbering the orchestrator's `sessions` array would break the VS Code dashboard. The runner only ever touches `controlPort`; everything else is preserved.
- 4KB body cap and strict method/path enforcement on the control endpoint, even though the surface is bound to localhost. Defence in depth.
- Did not touch the `aahp overnight` command in this PR - issue #28 specifies `aahp run` only. Overnight can be wired in a follow-up; the cost would be one more `startControlServer()` call site.
- CLI backends (claude-cli, gemini, codex) get SIGTERM-then-SIGKILL on abort but cannot capture token usage today. Both gaps are noted in the issue body and on the PR for follow-up.
- Did not touch `CLAUDE.md` - the working tree showed an unrelated style-rule diff from another session. Leaving it for the parallel session to commit.

**Open items:**

- PRs #29 (issue #27) and #30 (issue #28) are open and awaiting review.
- After both land, bump version, tag a release, let autopublish ship to npm. Then notify the hub side that T-004 and T-005 are unblocked.
- Three Dependabot PRs from earlier today are also open: #24 @anthropic-ai/sdk 0.91.1, #25 vitest 4.1.5, #26 ora 9.4.0. Out of scope for this session per the brief.
- Token usage parsing for CLI backends (claude-cli, gemini, codex): each prints token counts in its summary output but the format varies. Worth a separate task once the SDK + Copilot wiring proves itself in production.

---

## [2026-04-12] Claude Sonnet 4.6: T-010 + T-011 + T-012

> **Agent:** claude-sonnet-4-6
> **Session ID:** T-010-T-011-T-012-2026-04-12
> **Timestamp:** 2026-04-12T14:06:00.000Z

**What was done:**

- T-010: Merged Dependabot PRs #15 (@types/node), #17 (vite 8.0.5), #14 (TypeScript 6.0) via `gh pr merge`
- T-010: Resolved PR #16 (@anthropic-ai/sdk 0.82.0) manually - package-lock conflict from earlier merges
- T-010: Removed `import('node-fetch')` from `runPlanningAgent` - TypeScript 6.0 rejected it; unnecessary in Node 20+ (native fetch available)
- T-010: `npm install` confirmed 0 vulnerabilities; all 5 Dependabot security alerts resolved
- T-011: `npm test` - 174 tests passing in 11 suites (up from 160; includes tests added since last run)
- T-012: Bumped package version to 0.2.0; renamed package to `@elvatis_com/aahp-runner`
- T-012: Fixed README install command (`npm install -g @elvatis_com/aahp-runner`)
- T-012: Ran `npm pkg fix` to correct bin paths and normalize repository URL
- T-012: Created GitHub release v0.2.0; autopublish workflow triggered and succeeded

**Decisions made:**

- Merged PRs #15/#17/#14 via GitHub CLI merge (not squash/rebase) to preserve Dependabot commit metadata
- PR #16 conflict resolved by editing package.json directly + `npm install` to regenerate lock; cleaner than interactive rebase on Dependabot branch
- node-fetch removal: Node 20 (minimum engine) has native `fetch` globally; the import was dead code anyway (no `node-fetch` in package.json)
- Used GitHub release to trigger autopublish rather than `npm publish` locally (no npm token on this machine; workflow has NPM_TOKEN secret)

**Open items:**

- GitHub Actions: actions/checkout@v4 and setup-node@v4 will warn on Node 20 deprecation (non-urgent, deadline Sep 2026)
- vscode-extension/ directory not reviewed this session

---

## [2026-03-19] Claude Sonnet 4.6: T-005 + T-006 + T-008

**Agent:** Claude Sonnet 4.6
**Phase:** implement
**Branch:** main
**Tasks:** T-005, T-006, T-007 (agent tests were pre-existing), T-008

### What was done

**T-005 - `aahp status --quick`:**
- Added `--quick` / `-q` flag to existing `status` command
- Added `--project` / `-p` flag to point at a specific project directory
- Quick mode reads `.ai/handoff/MANIFEST.json` from cwd (or `--project` path)
- Shows: project name, phase, backend/agent, last run timestamp, commit SHA, tasks breakdown (active/ready/blocked/done), last log line
- No network calls, no root scan - instant read from local handoff files

**T-006 - `aahp archive`:**
- New `archive` command added to cli.ts
- Moves `.ai/handoff/LOG.md` to `.ai/handoff/logs/LOG-YYYY-MM-DD.md`
- Creates a fresh `LOG.md` with project name header and archive timestamp
- Keeps last N archived logs (`--keep N`, default 10); prunes oldest beyond limit
- Handles duplicate archive names on the same day (counter suffix)
- Supports `--dry-run` flag to preview without changes
- Supports `--project` flag to target a different directory
- 14 tests in `src/archive.test.ts`

**T-008 - Retry with exponential backoff:**
- `withRetry<T>(fn, opts)` exported from `agent.ts`
- Configurable: `maxRetries` (default 3), `baseDelayMs` (default 1000), `onRetry` callback
- Delay schedule: `baseDelayMs * 2^(attempt-1)` (1s, 2s, 4s by default)
- Retries both thrown errors and `success=false` results
- Non-retryable immediately: "No agent backend", "Claude Code CLI not found", "GitHub Copilot token not found", "token invalid or expired"
- `runAgent()` accepts optional `retryOptions` parameter
- 18 tests in `src/retry.test.ts`

**Tests:** 160 total (up from 128). All passing.

### Decisions made

- `status --quick` extends the existing command rather than a new top-level subcommand to avoid name conflict with the full project-scan `status`
- `archive` creates `logs/` inside `.ai/handoff/` to keep archives co-located with handoff files
- `withRetry` is a standalone exported utility (not baked into each backend function) so callers can opt in and configure per-use
- Non-retryable list uses `includes()` substring match to catch variations of the error messages

---

## [2026-02-27] Claude Opus 4.6: Add GitHub Actions CI pipeline (T-001)

**Agent:** Claude Opus 4.6
**Phase:** implement
**Branch:** main
**Tasks:** T-001

### What was done

- Created `.github/workflows/ci.yml` - GitHub Actions CI pipeline
- Triggers on push to main and pull requests to main
- Matrix build across Node.js 20 and 22
- Steps: checkout, setup Node.js with npm cache, npm ci, npm run build, verify dist output
- Explicit `permissions: contents: read` for security
- Updated all handoff files: MANIFEST.json (T-001 done), STATUS.md, NEXT_ACTIONS.md, LOG.md

### Decisions made

- Used Node.js 20 + 22 matrix (20 is current LTS, 22 is next LTS)
- Added dist output verification step to catch silent compilation failures
- No lint step since ESLint is not configured yet
- No test step since tests don't exist yet (T-002)

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

## [prior sessions] elvatis: Initial aahp-runner implementation

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
