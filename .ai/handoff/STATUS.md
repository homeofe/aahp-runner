# aahp-runner: Current State of the Nation

> Note (2026-07-12, claude-opus-4-8): synced canonical AAHP gate scripts from homeofe/improvements (adds the realpath-relative PII validator invocation that fixes the Windows/MSYS artifact; AAHP_HANDOFF_FILES preserved).

> Last updated: 2026-06-28 by claude-opus-4-8
> Commit: 9068353 (latest on main)
>
> Security fix (2026-06-28, this session): scanner.ts had three execSync calls
> that interpolated a git-remote-derived `owner/repo` slug directly into shell
> command strings (gh issue list --repo ${repo} ...), allowing command injection
> via a crafted .git/config remote URL containing shell metacharacters such as
> $(), backticks, semicolons, or pipes. Fix: (1) added validateGitHubRepo()
> which rejects any slug not matching the strict allowlist [A-Za-z0-9._-] with
> no leading hyphen on either segment; (2) all three call sites now use
> execFileSync with arguments passed as an array (no shell). detectGitHubRepo
> also switched from execSync to execFileSync. Regression tests added in
> scanner.test.ts (13 new validateGitHubRepo cases). 228 tests pass, 0 build
> warnings.
>
> Security fix (2026-06-28, prior session): scanner.ts ensureLabel ran
> `gh label create` via string execSync with an unquoted, git-remote-derived
> `--repo` value (command injection). It now uses execFileSync (no shell).
> resolveSafe (tools.ts) confined to the single target repo.
>
> **Rule:** This file is rewritten (not appended) at the end of every session.
> It reflects the *current* reality, not history. History lives in LOG.md.

---

<!-- SECTION: summary -->
## Summary

aahp-runner v0.3.0 on main. Two PRs open from this session:
- **#29** (T-013, closes #27): adds optional token-usage fields to RunMetric
  and wires SDK + Copilot backends to populate them.
- **#30** (T-014, closes #28): new HTTP control endpoint on 127.0.0.1 with
  `/abort` route, sessions.json controlPort discovery, and abort plumbing
  through every backend.

Both unblock work in the sister repo `aahp-hub` (T-005 and T-004).

209 Vitest tests passing on PR #30 (was 190 before this session). 0 build
warnings, 0 type errors. CLAUDE.md has an unrelated styling diff from a
parallel session, untouched here.
<!-- /SECTION: summary -->

---

<!-- SECTION: build_health -->
## Build Health

| Check | Result | Notes |
|-------|--------|-------|
| `npm run build` | (Verified) | Clean on both PR branches - 2026-04-27 |
| `npm test` (#27 branch) | (Verified) | 195 tests, 12 suites - 2026-04-27 |
| `npm test` (#28 branch) | (Verified) | 209 tests, 13 suites - 2026-04-27 |
| `aahp list` | (Verified prior) | Reads config rootDir correctly |
| `aahp run` | (Verified prior) | 5 backends: claude, gemini, codex, copilot, sdk |
| `aahp config` | (Verified prior) | Reads/writes ~/.aahp-runner.json |
| Security alerts | 2 open (Dependabot) | postcss + uuid - both transitive devDeps |
| Dependabot PRs | 3 open | #24 sdk 0.91.1, #25 vitest 4.1.5, #26 ora 9.4.0 |
| Open feature PRs | 2 (this session) | #29 (T-013), #30 (T-014) |
| npm publish | v0.3.0 latest | Published via Auto-Publish workflow earlier today |
<!-- /SECTION: build_health -->

---

<!-- SECTION: components -->
## Components

| Component | Path | State | Notes |
|-----------|------|-------|-------|
| CLI entry point | `src/cli.ts` | (Verified) | 11 commands + control-server lifecycle on PR #30 |
| Agent backends | `src/agent.ts` | (Verified) | 5 backends (claude-cli, gemini, codex, copilot, sdk); abortSignal threading on PR #30 |
| Project scanner | `src/scanner.ts` | (Verified prior) | Null task guards |
| Scheduler | `src/scheduler.ts` | (Verified prior) | cron + Task Scheduler |
| Tool definitions | `src/tools.ts` | (Verified prior) | 6 tools for tool_use |
| Status board | `src/status-board.ts` | (Verified prior) | Live terminal display |
| Metrics store | `src/metrics-store.ts` | (Verified) | JSONL persistence; token fields added on PR #29 |
| Resource monitor | `src/resource-monitor.ts` | (Verified prior) | CPU/memory tracking |
| Alerting | `src/alerting.ts` | (Verified prior) | Webhook/Slack |
| Control server | `src/control-server.ts` | (Verified, PR) | NEW on PR #30 - HTTP /abort endpoint |
| Init | `src/init.ts` | (Verified prior) | Bootstrap .ai/handoff/ |
| Types | `src/types.ts` | (Verified prior) | AahpTask, AahpManifest, AahpProject |
| Tests | `src/*.test.ts` | (Verified) | 209 on PR #30 (was 190 on main) |
<!-- /SECTION: components -->

---

<!-- SECTION: dependencies -->
## Dependencies (current on main)

| Package | Version | Notes |
|---------|---------|-------|
| `@anthropic-ai/sdk` | ^0.90.0 | Dependabot has #24 open for 0.91.1 |
| `typescript` | ^6.0.3 | |
| `@types/node` | ^25.6.0 | |
| `vitest` | ^4.1.4 | Dependabot has #25 open for 4.1.5 |
| `chalk` | ^5.3.0 | |
| `commander` | ^14.0.3 | |
| `ora` | ^9.3.0 | Dependabot has #26 open for 9.4.0 |
<!-- /SECTION: dependencies -->

---

<!-- SECTION: in_flight -->
## In Flight (this session)

| ID | What | PR | State |
|----|------|----|-------|
| T-013 | Token totals in RunMetric (issue #27) | #29 | Open, awaiting review |
| T-014 | /abort endpoint (issue #28) | #30 | Open, awaiting review |

Both PRs are clean: type-check passes, full test suite passes, no merge
conflicts at time of opening, no security alerts introduced.
<!-- /SECTION: in_flight -->

---

<!-- SECTION: what_is_missing -->
## What is Missing

| Gap | Severity | Description |
|-----|----------|-------------|
| Token usage for CLI backends | LOW | claude-cli, gemini, codex - need summary-line parsing |
| Abort endpoint in `aahp overnight` | LOW | Only wired into `aahp run` per issue #28 scope |
| Hub-side reading of new fields | EXTERNAL | aahp-hub T-004 and T-005 land after these PRs merge |
| GitHub Actions Node 20 deprecation | LOW | Will need bump by Sep 2026 |
| postcss + uuid Dependabot alerts | LOW | Transitive devDeps; no runtime impact |
<!-- /SECTION: what_is_missing -->

---

<!-- SECTION: cross_repo_unblocks -->
## Cross-Repo Unblocks (when these PRs merge)

| Sister repo | Task | Unblocks because |
|-------------|------|------------------|
| aahp-hub | T-005 (token column) | RunMetric exposes inputTokens / outputTokens / modelId |
| aahp-hub | T-004 (abort button) | sessions.json exposes controlPort; POST /abort works |
<!-- /SECTION: cross_repo_unblocks -->

<!-- aahp-gate -->
_AAHP verify gate: v3.0.2 synced 2026-06-20._

> 2026-06-21 install-hooks.sh: Windows drive-letter path fix propagated from AAHP.

> 2026-06-21 ci: add supply-chain-guard v5.2.35 Action workflow (fail-on critical).

> 2026-06-21 ci(aahp): fix unquoted next_task_id + lint-handoff noreply@ PII exclusion.

> 2026-06-27 ci: migrate npm publish to OIDC trusted publishing (supply-chain-guard pattern); publish + release jobs integrated into ci.yml (semver-tag + workflow_dispatch triggered, --provenance, id-token write, no NPM_TOKEN); removed token-based auto-publish.yml.

> 2026-06-27 ci: re-pin supply-chain-guard to v5.2.37 (be1d718b17cc38e4bce7fa48579b7112e557943b) for the PR-comment crash fix; enabled Dependabot github-actions weekly updates.

> 2026-06-27 docs(readme): add AAHP/CI status badges to README top (CI, AAHP Verify, Supply Chain Guard, Security/CodeQL, npm, License); only badges for workflows that exist in .github/workflows/ were added.

> 2026-06-30 verify: added reviewed expiring PII allowlist, rolled out from AAHP v3.2.0.

> 2026-06-30 ci: exempt Dependabot from the aahp-verify handoff gate (keep supply-chain-guard/codeql/build).
- 2026-07-03: ci: supply-chain-guard now tracks the moving @v5 release branch instead of a stale SHA pin (owner rule: consumers pin @v5, the release workflow moves it - currently v5.6.1). Ends the recurring stale/broken-pin churn (v5.2.35 crash wave). Config change only.
