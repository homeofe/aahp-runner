# aahp-runner: Current State of the Nation

> Last updated: 2026-02-27 by Claude Opus 4.6
> Commit: pending
>
> **Rule:** This file is rewritten (not appended) at the end of every session.
> It reflects the *current* reality, not history. History lives in LOG.md.

---

<!-- SECTION: summary -->
aahp-runner v0.1.0 is functional and npm-ready. CLI builds and runs correctly. Three
agent backends: claude-cli (Claude Code), GitHub Copilot, and Anthropic SDK. Commands:
list, run, config, schedule, status. Guided wizard for first-time users. Parallel
agent execution with concurrency limit (--limit). Windows Task Scheduler integration.
GitHub Actions CI pipeline (Node 20+22). 49 Vitest tests. Package configured for npm
publish (files, engines, keywords, prepublishOnly). Run `npm publish` to release.
<!-- /SECTION: summary -->

---

<!-- SECTION: build_health -->
## Build Health

| Check | Result | Notes |
|-------|--------|-------|
| `npm run build` | ✅ | TypeScript compiles cleanly to dist/ |
| `aahp list` | ✅ | Scans projects, shows tasks correctly |
| `aahp status` | ✅ | Quick overview works |
| `aahp run` | ✅ | All three backends functional |
| `aahp config` | ✅ | Reads/writes ~/.aahp-runner.json |
| `aahp schedule` | ✅ | Windows Task Scheduler registration |
| Automated tests | ✅ | 49 Vitest tests, all passing |
| CI pipeline | ✅ | GitHub Actions on push/PR, Node 20+22 |
| `npm pack --dry-run` | ✅ | 24 files, 31.3 kB packed (with .d.ts types) |
<!-- /SECTION: build_health -->

---

<!-- SECTION: components -->
## Components

| Component | Path | State | Notes |
|-----------|------|-------|-------|
| CLI entry point | `src/cli.ts` | ✅ Complete | 5 commands + guided wizard |
| Agent backends | `src/agent.ts` | ✅ Complete | claude-cli, copilot, sdk |
| Project scanner | `src/scanner.ts` | ✅ Complete | Reads MANIFEST.json, builds system prompt |
| Windows Scheduler | `src/scheduler.ts` | ✅ Complete | Daily Task Scheduler registration |
| Tool definitions | `src/tools.ts` | ✅ Complete | read/write/list/run/git tools |
| TypeScript types | `src/types.ts` | ✅ Complete | AahpTask, AahpManifest, AahpProject |
| Compiled output | `dist/` | ✅ Up to date | Built from src/ |
| README | `README.md` | ✅ Complete | Setup, commands, examples |
| CI pipeline | `.github/workflows/ci.yml` | ✅ Complete | Build on Node 20+22 |
| Automated tests | `src/*.test.ts` | ✅ Complete | 49 Vitest tests |
| LICENSE file | `LICENSE` | ✅ Complete | MIT license |
| npm publish config | `package.json` | ✅ Ready | files, types, engines, keywords, prepublishOnly |
<!-- /SECTION: components -->

---

<!-- SECTION: what_is_missing -->
## What is Missing

| Gap | Severity | Description |
|-----|----------|-------------|
| Linux/macOS cron | LOW | `aahp schedule` only supports Windows |
<!-- /SECTION: what_is_missing -->

---

## Trust Levels

- **(Verified)**: Build passes, CLI functional, all backends tested manually
- **(Assumed)**: Copilot backend works in unattended mode, Windows scheduler fires correctly
- **(Unknown)**: Behavior on Linux/macOS (scheduler), edge cases in parallel execution
