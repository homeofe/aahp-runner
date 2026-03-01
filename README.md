# aahp-runner

> Autonomous agent runner for AAHP v3 projects. Spawns Claude agents to work through tasks across all your repos - unattended or on-demand.

---

## The AAHP Toolchain

> **Install both packages for the full experience.**

| Package | What it does | When to use |
|---------|-------------|-------------|
| **[aahp-orchestrator](https://github.com/homeofe/aahp-orchestrator)** | VS Code extension. Injects AAHP context into Copilot/Claude Code while *you* code. Live status bar, `@aahp` chat, sidebar dashboard. | Every coding session - your human-in-the-loop assistant. |
| **aahp-runner** ← you are here | Autonomous CLI. Spawns Claude agents that implement tasks, run tests, and commit - no human input needed. Schedulable. | Overnight / CI - your unattended worker. |

Together they cover the full AAHP loop: you plan and guide during the day → the runner works through tasks at night → you wake up to committed progress.

---

## How it works

1. Scans a root development folder for all repos with `.ai/handoff/MANIFEST.json`
2. For each project with `ready` or `in_progress` tasks, spawns an agent using the configured backend
3. The agent reads the full AAHP context (phase, task, conventions, trust state) and uses tools to:
   - Read/write files
   - Run builds and tests
   - Commit changes
   - Update MANIFEST.json (marks task done)
4. Can run on a **daily schedule** via cron (Linux/macOS) or Windows Task Scheduler

### Agent backends

| Backend | Description | Requirements |
|---------|-------------|-------------|
| `auto` (default) | Auto-detects: tries `claude`, then `copilot` | Claude Code or Copilot extension |
| `claude` | Claude Code VS Code extension | Claude Code extension installed |
| `copilot` | GitHub Copilot via `gh` CLI | `gh auth login` |
| `sdk` | Anthropic API directly | `ANTHROPIC_API_KEY` env var |

---

## Setup

```bash
npm install -g aahp-runner

# Configure once (API key only needed for --backend sdk)
aahp-runner config --root "E:\_Development"

# For SDK backend (direct Anthropic API)
aahp-runner config --api-key "sk-ant-..."

# Or use env vars
export AAHP_ROOT="E:\_Development"
export ANTHROPIC_API_KEY="sk-ant-..."   # only needed for --backend sdk
```

---

## Commands

```bash
# See all projects and their top ready task
aahp-runner list

# Quick status overview
aahp-runner status

# Auto-refresh status every 3s (Ctrl+C to stop)
aahp-runner status --watch

# Run agent on a specific project (interactive confirm)
aahp-runner run openclaw-ops

# Run with explicit backend, timeout, and concurrency limit
aahp-runner run --all --backend claude --timeout 20 --limit 3

# Run agent on all projects with ready tasks
aahp-runner run --all

# Run all without confirmation (for scheduled/unattended)
aahp-runner run --all --yes

# Register a daily scheduled job (cron on Linux/macOS, Task Scheduler on Windows)
aahp-runner schedule --time 02:00

# Remove the scheduled job
aahp-runner schedule --remove

# Show or tail agent logs
aahp-runner logs                      # list all log files
aahp-runner logs openclaw-ops         # show last 40 lines
aahp-runner logs openclaw-ops -f      # stream in real-time (like tail -f)
aahp-runner logs openclaw-ops -n 100  # show last 100 lines

# Show historical run metrics
aahp-runner metrics                   # last 30 days, all repos
aahp-runner metrics --repo openclaw-ops --days 7
aahp-runner metrics --json            # raw JSON export

# Show/set config
aahp-runner config
aahp-runner config --root "E:\_Development" --api-key "sk-ant-..."
aahp-runner config --backend claude
aahp-runner config --timeout 20
aahp-runner config --alert-webhook "https://example.com/hook"
aahp-runner config --alert-slack "https://hooks.slack.com/..."
aahp-runner config --alert-clear
```

Running `aahp` or `aahp-runner` with no arguments launches a guided setup wizard.

---

## What the agent does

For each project+task, the agent:
1. Reads relevant source files to understand the codebase
2. Implements the task
3. Runs tests/builds to verify
4. Commits with a conventional commit message
5. Updates `.ai/handoff/MANIFEST.json` - marks task done, updates timestamp

The agent has these tools: `read_file`, `write_file`, `list_dir`, `run_command`, `git_status`, `git_commit`

---

## Scheduled runs

```bash
aahp-runner schedule --time 02:00
```

Registers a daily job that runs at 2:00 AM, processing all projects with ready tasks unattended.

- **Linux/macOS**: installs a cron entry (marker: `# AAHP-Runner-Daily`)
- **Windows**: creates a Task Scheduler job (`AAHP-Runner-Daily`)

To remove:

```bash
aahp-runner schedule --remove
```

---

## Requirements

- Node.js >= 20
- Repos with AAHP v3 `.ai/handoff/MANIFEST.json` ([spec](https://github.com/homeofe/AAHP))
- One of: Claude Code extension, GitHub Copilot (`gh auth login`), or Anthropic API key (`--backend sdk`)

---

## License

MIT © [elvatis](https://github.com/elvatis)
