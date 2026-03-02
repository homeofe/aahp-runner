# aahp-runner

> Autonomous agent runner for AAHP v3 projects. Spawns Claude/Copilot agents to work through tasks across all your repos - unattended or on-demand. Includes AI-driven planning, overnight loops, and follow-up chaining.

---

## The AAHP Toolchain

> **Install both packages for the full experience.**

| Package | What it does | When to use |
|---------|-------------|-------------|
| **[aahp-orchestrator](https://github.com/homeofe/aahp-orchestrator)** | VS Code extension. Injects AAHP context into Copilot/Claude Code while *you* code. Live status bar, `@aahp` chat, sidebar dashboard. | Every coding session - your human-in-the-loop assistant. |
| **aahp-runner** ← you are here | Autonomous CLI. Spawns agents that plan tasks, implement them, run tests, and commit - no human input needed. Schedulable. | Overnight / CI - your unattended worker. |

Together they cover the full AAHP loop: you guide during the day → the runner plans and implements at night → you wake up to committed progress.

---

## How it works

1. Scans a root development folder for all repos with `.ai/handoff/MANIFEST.json`
2. Syncs GitHub issues ↔ MANIFEST, imports NEXT_ACTIONS.md tasks, creates missing GitHub issues
3. For each project with `ready` or `in_progress` tasks, spawns an agent using the configured backend
4. The agent reads the full AAHP context (phase, task, conventions) and uses tools to:
   - Read/write files, run builds and tests, commit changes
   - Update MANIFEST.json (marks task done, updates quick_context)
   - Close the linked GitHub issue
   - Regenerate NEXT_ACTIONS.md with current task state
5. Logs are written to each repo's `.ai/logs/YYYY-MM-DD.log` (auto-gitignored)
6. Can run on a **daily schedule** via cron (Linux/macOS) or Windows Task Scheduler

### Agent backends

| Backend | Description | Requirements |
|---------|-------------|-------------|
| `auto` (default) | Auto-detects: tries `claude`, then `copilot`, then `sdk` | Claude Code or Copilot extension |
| `claude` | Claude Code VS Code extension | Claude Code extension installed |
| `copilot` | GitHub Copilot via `gh` CLI | `gh auth login` |
| `sdk` | Anthropic API directly | `ANTHROPIC_API_KEY` env var |

---

## Setup

```bash
npm install -g aahp-runner

# Configure once (API key only needed for --backend sdk)
aahp config --root "E:\_Development"

# For SDK backend (direct Anthropic API)
aahp config --api-key "sk-ant-..."

# Or use env vars
export AAHP_ROOT="E:\_Development"
export ANTHROPIC_API_KEY="sk-ant-..."   # only needed for --backend sdk
```

---

## Commands

### `aahp list` — inspect task state

```bash
aahp list                   # repos with actionable tasks
aahp list --all             # include idle repos (no tasks)
```

### `aahp status` — live overview

```bash
aahp status                 # snapshot of live agents + project table
aahp status --watch         # auto-refresh every 3s (Ctrl+C to stop)
```

### `aahp run` — execute agents

```bash
# Run agent on a specific project (interactive confirm)
aahp run openclaw-ops

# Run all projects with ready tasks (parallel, live status board)
aahp run --all --yes

# Cap at 3 concurrent agents
aahp run --all --yes --limit 3

# Explicit backend or timeout
aahp run --all --yes --backend claude --timeout 20

# Follow-up mode: after completing tasks, auto-plan idle repos and
# re-run new tasks. Chains until no more tasks or plans are generated.
aahp run --all --yes --follow-up
aahp run --all --yes --follow-up --limit 3
```

### `aahp plan` — AI-driven roadmap generation

Analyzes idle repos (no ready tasks) and instructs an agent to write 3-5
new tasks to `.ai/handoff/NEXT_ACTIONS.md`. After planning, the scanner
pipeline automatically syncs new tasks → MANIFEST → GitHub issues.

```bash
aahp plan                   # plan first idle repo (asks for confirm)
aahp plan --all --yes       # plan ALL idle repos without prompts
aahp plan openclaw-ops      # plan a specific repo
aahp plan --all --local     # include repos with no GitHub remote
aahp plan --backend claude --timeout 8
```

The planning agent reads README.md, package.json, and recently completed
tasks. It writes NEXT_ACTIONS.md and does **not** commit.

### `aahp overnight` — fully autonomous loop

Full plan → run → commit/push cycle that repeats until `--hours` expires.
Logs are written to `rootDir/.ai/logs/overnight-YYYY-MM-DD.log`.

```bash
aahp overnight --yes                    # 8h run, limit 5 agents
aahp overnight --yes --hours 0          # run forever (Ctrl+C to stop)
aahp overnight --yes --hours 4 --limit 3
aahp overnight --yes --pause 10         # 10min pause between cycles
aahp overnight --yes --local            # include local-only repos
aahp overnight --yes --backend copilot
```

Each cycle:
1. **Plan** — runs planning agent on any idle repos
2. **Run** — spawns agents on all actionable tasks (with live status board)
3. **Commit** — commits and pushes all dirty repos

PowerShell wrapper (`aahp-overnight.ps1`) also available for Task Scheduler.

### `aahp logs` — inspect agent output

Logs are written to each repo's `.ai/logs/YYYY-MM-DD.log`. The command
scans all repos in `--root` for per-repo logs, with fallback to `~/.aahp/logs/`.

```bash
aahp logs                          # list all log files with relative paths
aahp logs openclaw-ops             # show last 40 lines
aahp logs openclaw-ops -f          # stream in real-time (like tail -f)
aahp logs openclaw-ops -n 100      # show last 100 lines
```

### `aahp metrics` — run history

```bash
aahp metrics                       # last 30 days, all repos
aahp metrics --repo openclaw-ops --days 7
aahp metrics --json                # raw JSON export
```

### `aahp config` — persistent settings

```bash
aahp config                        # show current config
aahp config --root "E:\_Development"
aahp config --backend claude
aahp config --timeout 20           # default per-agent timeout (minutes)
aahp config --api-key "sk-ant-..."
aahp config --alert-webhook "https://example.com/hook"
aahp config --alert-slack "https://hooks.slack.com/..."
aahp config --alert-clear
```

### `aahp schedule` — nightly cron

```bash
aahp schedule --time 02:00         # register daily job at 02:00
aahp schedule --remove             # remove the job
```

- **Linux/macOS**: installs a cron entry (marker: `# AAHP-Runner-Daily`)
- **Windows**: creates a Task Scheduler job (`AAHP-Runner-Daily`)

Running `aahp` with no arguments launches a guided setup wizard.

---

## Autonomy modes

| Mode | Command | Behaviour |
|------|---------|-----------|
| **Single pass** | `aahp run --all --yes` | Run current ready tasks, then stop |
| **Self-chaining** | `aahp run --all --yes --follow-up` | Run → plan idle repos → run new tasks → repeat until done |
| **Overnight loop** | `aahp overnight --yes` | Plan + run + commit cycle, repeats for 8h |
| **Forever daemon** | `aahp overnight --yes --hours 0` | Same loop, never stops (Ctrl+C) |
| **Scheduled** | `aahp schedule --time 02:00` | OS-level daily trigger of `aahp run --all --yes` |

---

## Log layout

```
repoPath/
  .ai/
    handoff/
      MANIFEST.json          task registry + session metadata
      NEXT_ACTIONS.md        human-readable task roadmap
      CONVENTIONS.md         code style rules for agents
    logs/                    agent run logs (auto-added to .gitignore)
      2026-03-02.log
      plan-2026-03-02.log    planning agent log

rootDir/
  .ai/
    logs/
      overnight-2026-03-02.log   overnight loop log

~/.aahp/
  logs/                      fallback (legacy) log location
  metrics.jsonl              run metrics (all repos, all time)
  sessions.json              live session state (used by VS Code extension)
```

---

## What the agent does per task

1. Reads relevant source files to understand the codebase
2. Implements the task (writes/edits files)
3. Runs tests/builds to verify
4. Commits with a conventional commit message
5. Updates `.ai/handoff/MANIFEST.json` - marks task done, updates timestamp
6. Closes the linked GitHub issue
7. Regenerates NEXT_ACTIONS.md with current task state

---

## Requirements

- Node.js >= 20
- Repos with AAHP v3 `.ai/handoff/MANIFEST.json` ([spec](https://github.com/homeofe/AAHP))
- One of: Claude Code extension, GitHub Copilot (`gh auth login`), or Anthropic API key (`--backend sdk`)
- `gh` CLI for GitHub issue sync (`gh auth login`)

---

## License

MIT © [elvatis](https://github.com/elvatis)
