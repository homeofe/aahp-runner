# aahp-runner

Autonomous agent runner for AAHP v3 projects. Spawns Claude/Copilot agents to work through tasks across all repos - unattended or on-demand.

## Tech Stack

- **Language**: TypeScript (ESM, strict)
- **Runtime**: Node.js >= 20
- **Testing**: Vitest
- **CLI**: Commander.js
- **Agent backends**: Claude Code CLI, GitHub Copilot (`gh`), Anthropic SDK
- **Dependencies**: chalk, ora (spinner)

## Commands

```bash
npm run build        # tsc -p ./
npm test             # vitest run
npm run test:watch   # vitest (watch mode)
npm run dev          # run CLI via ts-node
```

## Architecture

```
src/
  cli.ts              # CLI entry point (commander commands: list, run, plan, overnight, etc.)
  types.ts            # AahpTask, AahpManifest, AahpProject interfaces
  scanner.ts          # Scans repos for MANIFEST.json, syncs GitHub issues <-> tasks
  agent.ts            # Spawns agents (claude-cli, copilot, sdk backends)
  tools.ts            # Tool definitions for Claude tool_use (read_file, write_file, run_command, etc.)
  scheduler.ts        # OS-level cron/task scheduler integration
  status-board.ts     # Live terminal status display
  metrics-store.ts    # Run metrics (JSONL persistence)
  resource-monitor.ts # CPU/memory monitoring during agent runs
  alerting.ts         # Webhook/Slack alerting on failures
```

## Key Patterns

- **Scanner pipeline**: Discover repos -> parse MANIFEST.json -> sync GitHub issues -> resolve task dependencies
- **Agent backends**: Auto-detect claude > copilot > sdk. Each backend implements the same run interface.
- **Tool use**: SDK backend provides 6 tools (read_file, write_file, list_dir, run_command, git_status, git_commit)
- **AAHP compliance**: Agent updates MANIFEST.json (task status, checksums) and closes GitHub issues on completion

## Read First

- `.ai/handoff/STATUS.md` - Current project status
- `.ai/handoff/MANIFEST.json` - Task list and file map
- `.ai/handoff/NEXT_ACTIONS.md` - Prioritized task queue

## AI Workflow Framework

This project uses the [AI Workflow Improvement Framework](https://github.com/homeofe/improvements) with AAHP v3.

### Custom Commands

- `/handoff` - Complete AAHP handoff cycle
- `/route <task>` - Model routing recommendation
- `/status` - Project health dashboard
- `/next` - Pick next ready task
- `/review-cycle` - Multi-model review on recent changes

### Conventions

- English only (code, comments, docs, commits)
- No em dashes (use hyphens)
- AAHP protocol compliance for handoff operations
- ESM modules (`"type": "module"` in package.json)

### Multi-Model Strategy

- **Research**: Perplexity (web-grounded), Gemini (large context)
- **Architecture**: Opus, GPT-4 (hard reasoning)
- **Implementation**: Sonnet, Codex (fast coding)
- **Review**: Use a different provider than the implementer

See `.llm/ROUTING.md` for the full decision matrix.

## Style Rules

- Never use em dashes (—, U+2014) in any content: documentation, markdown, README, code comments, GitHub issue titles, or handoff files. Use a plain hyphen (-) instead.
- When reviewing existing files, scan for em dashes and replace them.
- Applies to all .md files, HTML templates, comments, and .ai/handoff files.
- If an AI tool auto-inserts em dashes (e.g. "Title - Subtitle"), fix before committing.
