# aahp-runner: Trust Register

> Tracks verification status of critical system properties.
> In multi-agent pipelines, hallucinations and drift are real risks.
> Every claim here has a confidence level tied to how it was verified.

---

## Confidence Levels

| Level | Meaning |
|-------|---------|
| **verified** | An agent executed code, ran tests, or observed output to confirm this |
| **assumed** | Derived from docs, config files, or chat, not directly tested |
| **untested** | Status unknown; needs verification |

---

## Build & Compilation

| Property | Status | Last Verified | Agent | TTL | Expires | Notes |
|----------|--------|---------------|-------|-----|---------|-------|
| `npm run build` succeeds | verified | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | tsc compiles cleanly |
| dist/cli.js is runnable | verified | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | git log shows passing |
| ESM imports resolve correctly | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | .js extensions present |

---

## CLI Functionality

| Property | Status | Last Verified | Agent | TTL | Expires | Notes |
|----------|--------|---------------|-------|-----|---------|-------|
| `aahp list` works | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | Based on code review |
| `aahp status` works | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | Based on code review |
| `aahp run` with claude-cli | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | spawn() pattern verified |
| `aahp run` with copilot | assumed | 2026-02-27 | Claude Sonnet 4.6 | 3d | 2026-03-02 | Not tested live |
| `aahp run` with sdk | assumed | 2026-02-27 | Claude Sonnet 4.6 | 3d | 2026-03-02 | Not tested live |
| `aahp config` reads/writes | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | Standard fs.writeFileSync |
| `aahp schedule` registers task | untested | - | - | - | - | Windows only, not verified |

---

## Agent Execution

| Property | Status | Last Verified | Agent | TTL | Expires | Notes |
|----------|--------|---------------|-------|-----|---------|-------|
| Parallel spawn works | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | spawn() vs execSync fix |
| Commit detection reliable | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | git log --since 5min |
| markTaskDone updates MANIFEST | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | Re-reads from disk |
| Concurrency limit works | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | runWithLimit logic |

---

## Repository

| Property | Status | Last Verified | Agent | TTL | Expires | Notes |
|----------|--------|---------------|-------|-----|---------|-------|
| No secrets in source | assumed | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | Code reviewed, no keys found |
| MIT LICENSE correct | assumed | 2026-02-27 | Claude Sonnet 4.6 | 30d | 2026-03-29 | package.json says MIT |
| No em dashes in source | verified | 2026-02-27 | Claude Sonnet 4.6 | 7d | 2026-03-06 | Prior commit removed them |

---

## Update Rules (for agents)

- Change `untested` - `verified` only after **running actual code/tests**
- Change `assumed` - `verified` after direct confirmation
- Never downgrade `verified` without explaining why in `LOG.md`
- Expired `verified` automatically downgrades to `assumed`
- High-churn properties (scripts, checksums): 1-3 day TTL
- Stable properties (schema, templates, architecture): 30 day TTL
- Add new rows when new system properties become critical

---

*Trust degrades over time. Re-verify periodically, especially after major changes.*
