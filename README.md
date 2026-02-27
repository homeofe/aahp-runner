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
2. For each project with `ready` or `in_progress` tasks, spawns a **Claude claude-opus-4-5 agent**
3. The agent reads the full AAHP context (phase, task, conventions, trust state) and uses tools to:
   - Read/write files
   - Run builds and tests
   - Commit changes
   - Update MANIFEST.json (marks task done)
4. Can run on a **daily schedule** via cron (Linux/macOS) or Windows Task Scheduler

---

## Setup

```bash
npm install -g aahp-runner

# Configure once
aahp-runner config --root "E:\_Development" --api-key "sk-ant-..."

# Or use env vars
export AAHP_ROOT="E:\_Development"
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Commands

```bash
# See all projects and their top ready task
aahp-runner list

# Quick status overview
aahp-runner status

# Run agent on a specific project (interactive confirm)
aahp-runner run openclaw-ops

# Run agent on all projects with ready tasks
aahp-runner run --all

# Run all without confirmation (for scheduled/unattended)
aahp-runner run --all --yes

# Register a daily scheduled job (cron on Linux/macOS, Task Scheduler on Windows)
aahp-runner schedule --time 02:00

# Remove the scheduled job
aahp-runner schedule --remove

# Show/set config
aahp-runner config
aahp-runner config --root "E:\_Development" --api-key "sk-ant-..."
```

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

- Node.js ≥ 20
- Anthropic API key (Claude claude-opus-4-5)
- Repos with AAHP v3 `.ai/handoff/MANIFEST.json` ([spec](https://github.com/homeofe/AAHP))

---

## License

MIT © [homeofe](https://github.com/homeofe)
