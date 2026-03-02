# NEXT_ACTIONS - aahp-runner

> **Auto-generated from MANIFEST.json after every agent session.**
> Priority order within each section. Work top-down. Skip blocked tasks.
> Each item is self-contained - agent can start without asking questions.

---

## Status Summary

| Status | Count | Tasks |
|--------|-------|-------|
| Done | 4 | T-001, T-002, T-003, T-004 |
| Ready | 5 | T-005, T-006, T-007, T-008, T-009 |
| Blocked | 0 | - |

---

## Ready - Work These Next

### T-005: Enhance `aahp status` quick-look output [medium] (issue #1)

- **Goal:** Make `aahp status` (without `--watch`) print a concise, scannable dashboard that shows task counts, last commit, and blocked/ready state for every discovered project - useful as a daily morning check.
- **Context:** `aahp status` exists but currently shows a table that could be more informative. GitHub issue #1 (homeofe/aahp-runner) requests a richer quick-look: per-project task breakdown (ready/blocked/done counts), last commit date, and overall health indicator. The `--watch` mode already refreshes live - this is about the single-shot output being more useful.
- **What to do:**
  1. Read `src/cli.ts` (the `status` command handler) and `src/status-board.ts` to understand current output
  2. Read `src/scanner.ts` (`scanProjects`) to see what project metadata is already available
  3. Enhance the single-shot status output to include:
     - Per-project row: name, phase, ready/blocked/done task counts, last commit hash + date
     - Summary footer: total projects, total ready tasks, total blocked tasks
     - Color coding: green for all-done, yellow for has-ready, red for has-blocked
  4. Keep `--watch` behavior unchanged
  5. Add tests in `src/status-board.test.ts` for the new formatting logic
  6. Update README.md command reference if output format changes
- **Files:** `src/cli.ts`, `src/status-board.ts`, `src/status-board.test.ts`, `src/scanner.ts` (read only)
- **Definition of Done:**
  - [ ] `aahp status` shows per-project task breakdown with ready/blocked/done counts
  - [ ] Summary footer with totals
  - [ ] Color-coded health indicators
  - [ ] Existing tests still pass
  - [ ] New tests cover the enhanced output formatting

### T-006: Add `aahp archive` command for LOG.md rotation [medium] (issue #2)

- **Goal:** Add a new CLI command that rotates old LOG.md entries into an archive file, keeping handoff files lean for agents with limited context windows.
- **Context:** GitHub issue #2 (homeofe/aahp-runner). As projects accumulate sessions, LOG.md grows unboundedly. Agents reading handoff context waste tokens on stale log entries. An `aahp archive` command should move entries older than N days into `.ai/handoff/LOG-archive-YYYY.md`, keeping only recent entries in LOG.md.
- **What to do:**
  1. Read `src/cli.ts` to understand existing command patterns (use `config` or `logs` as template)
  2. Add new `archive` command to the Commander program in `src/cli.ts`
  3. Implement archive logic:
     - Parse LOG.md for date-stamped session headers (e.g., `## Session - 2026-02-27`)
     - Accept `--days N` flag (default 30) - entries older than N days get archived
     - Accept `--project <name>` to target a single project, or archive all discovered projects
     - Move old entries to `.ai/handoff/LOG-archive-YYYY.md` (append, create if needed)
     - Rewrite LOG.md with only recent entries
     - Print summary: "Archived X entries from Y projects"
  4. Add tests in a new `src/archive.test.ts` for the date parsing and rotation logic
  5. Update README.md with the new command and its flags
- **Files:** `src/cli.ts`, `src/archive.test.ts` (new), `README.md`
- **Definition of Done:**
  - [ ] `aahp archive` rotates LOG.md entries older than 30 days by default
  - [ ] `--days N` flag overrides the retention window
  - [ ] `--project <name>` targets a single project
  - [ ] Archived entries are appended to `LOG-archive-YYYY.md`
  - [ ] Tests cover date parsing, rotation, and edge cases (empty LOG.md, no old entries)
  - [ ] README documents the command

### T-007: Add agent execution tests [high] (issue #3)

- **Goal:** Add unit tests for `src/agent.ts` - the most critical untested module (654 lines covering all three backends).
- **Context:** The test suite (98 tests) covers scanner, tools, scheduler, metrics, alerting, status-board, and resource-monitor - but agent.ts has zero tests. This is the core module that spawns Claude CLI processes, drives the Anthropic SDK message loop, and calls the Copilot API. Without tests, regressions in agent dispatch, tool execution, timeout handling, or task completion flow go undetected. The `(client.messages as any).create` type cast and unguarded `JSON.parse(call.function.arguments)` are specific risk areas.
- **What to do:**
  1. Read `src/agent.ts` thoroughly - understand `runAgent`, `runViaClaudeCLI`, `runViaSDK`, `runViaCopilot`, `markTaskDone`, `buildSystemPrompt`
  2. Read existing test patterns in `src/tools.test.ts` and `src/scanner.test.ts` for mocking conventions
  3. Create `src/agent.test.ts` with tests for:
     - `buildSystemPrompt` - verify prompt includes task title, project context, tool descriptions
     - `markTaskDone` - verify MANIFEST.json is updated correctly (status, completed timestamp)
     - `runViaSDK` - mock `@anthropic-ai/sdk` client, verify tool dispatch loop, verify max turns enforcement, verify deadline timeout
     - `runViaClaudeCLI` - mock `child_process.spawn`, verify args passed, verify timeout kill behavior
     - `runViaCopilot` - mock `fetch`, verify Copilot API request format, verify turn counting
     - Error paths: malformed tool arguments (unguarded JSON.parse), agent exceeding max turns, network timeout
  4. Use `vi.mock` to mock external dependencies (child_process, fetch, @anthropic-ai/sdk)
  5. Verify all existing tests still pass
- **Files:** `src/agent.ts` (read only), `src/agent.test.ts` (new)
- **Definition of Done:**
  - [ ] `src/agent.test.ts` exists with at least 15 tests
  - [ ] buildSystemPrompt output verified
  - [ ] markTaskDone MANIFEST mutation verified
  - [ ] SDK message loop tested with mocked client
  - [ ] Claude CLI spawn tested with mocked child_process
  - [ ] Copilot API tested with mocked fetch
  - [ ] Error paths covered (bad JSON, max turns, timeout)
  - [ ] `vitest run` passes with all new + existing tests

### T-008: Add retry logic with exponential backoff [medium] (issue #4)

- **Goal:** Add retry logic for transient failures in agent execution (API rate limits, network timeouts, GitHub CLI errors) so that overnight runs don't abort on temporary glitches.
- **Context:** Currently, any network failure or API error during agent execution fails the entire task immediately. The `overnight` command retries full cycles but not individual API calls. For long-running overnight sessions hitting rate limits or transient network issues, per-call retry with exponential backoff would significantly improve reliability. The Copilot backend already has a 2-minute per-request timeout but no retry. The SDK backend has no retry at all.
- **What to do:**
  1. Read `src/agent.ts` - identify all external calls: SDK `client.messages.create`, Copilot `fetch`, Claude CLI `spawn`
  2. Create a `src/retry.ts` utility module with:
     - `withRetry<T>(fn, opts)` - wraps an async function with retry logic
     - Options: `maxRetries` (default 3), `baseDelayMs` (default 1000), `maxDelayMs` (default 30000), `retryOn` (predicate function)
     - Exponential backoff with jitter: `delay = min(baseDelay * 2^attempt + random jitter, maxDelay)`
     - Only retry on transient errors (network, 429, 500-503) - not on 400/401/403
  3. Wrap SDK `client.messages.create` call in `withRetry`
  4. Wrap Copilot `fetch` call in `withRetry`
  5. Do NOT retry Claude CLI spawn (it manages its own session)
  6. Add tests in `src/retry.test.ts` for the utility function
  7. Log retry attempts so they appear in agent logs
- **Files:** `src/retry.ts` (new), `src/retry.test.ts` (new), `src/agent.ts`
- **Definition of Done:**
  - [ ] `src/retry.ts` exports `withRetry` with configurable options
  - [ ] Exponential backoff with jitter implemented
  - [ ] SDK and Copilot API calls wrapped with retry
  - [ ] Only transient errors trigger retry (429, 500-503, network errors)
  - [ ] Retry attempts are logged
  - [ ] Tests cover: successful retry, max retries exceeded, non-retryable error skips retry
  - [ ] All existing tests pass

### T-009: Add `--dry-run` flag to `aahp run` [low] (issue #5)

- **Goal:** Add a `--dry-run` flag that shows what agents would be spawned without actually executing them - useful for verifying scan results and task selection before committing to a full run.
- **Context:** Users running `aahp run` on a large dev root with many repos may want to preview which projects and tasks will be picked up before launching agents. Currently the only way to preview is `aahp list`, but that doesn't show backend selection, concurrency plan, or the system prompt that would be sent. A `--dry-run` flag bridges this gap, especially useful before scheduling overnight runs.
- **What to do:**
  1. Read `src/cli.ts` - find the `run` command handler
  2. Add `--dry-run` option to the `run` command
  3. When `--dry-run` is set:
     - Run `scanProjects` normally to discover tasks
     - For each project+task that would be picked, print: project name, task ID, task title, backend that would be used, system prompt summary (first 200 chars)
     - Print concurrency plan: "Would run N agents (limit: M)"
     - Skip actual agent execution - exit cleanly
  4. Add a test in the existing test files to verify dry-run produces output without spawning
  5. Update README.md run command section
- **Files:** `src/cli.ts`, `README.md`
- **Definition of Done:**
  - [ ] `aahp run --dry-run` shows planned agent spawns without executing
  - [ ] Output includes: project, task ID, title, backend, concurrency plan
  - [ ] No agents are actually spawned
  - [ ] README documents the flag
  - [ ] Existing tests pass

---

## Blocked

*(No blocked tasks)*

---

## Recently Completed

| ID | Task | What Was Done | When |
|----|------|--------------|------|
| T-004 | Add Linux/macOS cron support | Cross-platform scheduling with crontab detection, README updated | 2026-02-27 |
| T-003 | Publish to npm | Package published as aahp-runner, `npm install -g aahp-runner` works | 2026-02-27 |
| T-002 | Add automated tests (Vitest) | 67 Vitest unit tests, all passing, CI integration | 2026-02-27 |
| T-001 | GitHub Actions CI pipeline | `.github/workflows/ci.yml` - build on Node 20+22, push/PR to main | 2026-02-27 |
| - | Initial implementation | CLI, 3 backends, parallel execution, Windows scheduler | 2026-02-27 |
| - | Guided wizard | Step-by-step first-run experience | 2026-02-27 |
| - | Async parallel spawn | Real parallelism via spawn() instead of execSync | 2026-02-27 |
| - | --limit flag | Sliding-window concurrency control | 2026-02-27 |
| - | AAHP handoff files bootstrapped | .ai/handoff/ created (dogfooding) | 2026-02-27 |

---

## Reference: Key File Locations

| What | Where |
|------|-------|
| CLI entry point | `src/cli.ts` |
| Agent backends | `src/agent.ts` |
| Project scanner | `src/scanner.ts` |
| Scheduler (cross-platform) | `src/scheduler.ts` |
| Tool definitions | `src/tools.ts` |
| TypeScript types | `src/types.ts` |
| Status board | `src/status-board.ts` |
| Metrics store | `src/metrics-store.ts` |
| Resource monitor | `src/resource-monitor.ts` |
| Alerting | `src/alerting.ts` |
| README | `README.md` |
| Own handoff files | `.ai/handoff/` |

---

*This file is regenerated by each agent after completing its task. It reflects the live state of MANIFEST.json.*
