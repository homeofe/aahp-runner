#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import * as path from 'path'
import * as fs from 'fs'
import os from 'os'
import * as readline from 'readline'
import { scanProjects, getTopTask } from './scanner.js'
import { runAgent } from './agent.js'
import { runAsync } from './tools.js'
import { loadConfig, saveConfig, registerWindowsScheduler } from './scheduler.js'
import { StatusBoard, AgentStatus, LOG_DIR, agentLogPath } from './status-board.js'

const DEFAULT_ROOT = process.env['AAHP_ROOT'] ?? path.join(os.homedir(), 'Development')

/** Read ~/.aahp/sessions.json written by aahp-orchestrator SessionMonitor or aahp-runner */
function readLiveSessions(): Array<{ repoPath: string; repoName: string; taskId: string; taskTitle: string; backend: string; startedAt: string }> {
  const lockFile = path.join(os.homedir(), '.aahp', 'sessions.json')
  try {
    if (!fs.existsSync(lockFile)) return []
    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { sessions?: unknown[] }
    return Array.isArray(data.sessions) ? data.sessions as ReturnType<typeof readLiveSessions> : []
  } catch { return [] }
}

/** Read last line from today's agent log for a repo */
function getLastLogLine(repoName: string): string {
  try {
    const stamp = new Date().toISOString().slice(0, 10)
    const logPath = path.join(os.homedir(), '.aahp', 'logs', `${repoName}-${stamp}.log`)
    if (!fs.existsSync(logPath)) return ''
    const content = fs.readFileSync(logPath, 'utf8')
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('='))
    const last = lines[lines.length - 1] ?? ''
    return last.replace(/\s+/g, ' ').slice(0, 50)
  } catch { return '' }
}

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all AAHP projects and their top ready tasks')
  .option('-r, --root <path>', 'Root development folder', DEFAULT_ROOT)
  .action((opts: { root: string }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const projects = scanProjects(rootDir)

    if (projects.length === 0) {
      console.log(chalk.yellow(`No AAHP projects found in ${rootDir}`))
      console.log(chalk.gray('Make sure repos have .ai/handoff/MANIFEST.json'))
      return
    }

    console.log(chalk.bold(`\n📋 AAHP Projects in ${rootDir}\n`))
    const statusIcon: Record<string, string> = {
      done: '✅', in_progress: '🔄', ready: '⏳', blocked: '🚫', pending: '💤',
    }

    for (const project of projects) {
      const topTask = getTopTask(project)
      const taskCount = project.readyTasks.length + project.activeTasks.length
      const phase = chalk.cyan(`[${project.manifest.last_session.phase}]`)

      if (taskCount === 0) {
        console.log(chalk.gray(`  ${project.name} ${phase} - no ready tasks`))
        continue
      }

      console.log(chalk.bold(`  ${project.name} ${phase}`))
      console.log(chalk.gray(`    ${project.manifest.quick_context.slice(0, 80)}`))
      if (topTask) {
        const [id, task] = topTask
        console.log(`    ${statusIcon[task.status] ?? '•'} ${chalk.yellow(id)}: ${task.title} ${chalk.gray(`(${task.priority})`)}`)
      }
      if (project.readyTasks.length + project.activeTasks.length > 1) {
        console.log(chalk.gray(`    ... and ${taskCount - 1} more task(s)`))
      }
      console.log()
    }

    const total = projects.reduce((n, p) => n + p.readyTasks.length + p.activeTasks.length, 0)
    console.log(chalk.bold(`  Total: ${projects.length} projects, ${total} actionable tasks`))
    console.log(chalk.gray(`\n  Run: aahp-runner run <project-name>`))
    console.log(chalk.gray(`  Run all: aahp-runner run --all`))
  })

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command('run [project]')
  .description('Run the agent on a project\'s top task. Omit project to pick interactively.')
  .option('-r, --root <path>', 'Root development folder', DEFAULT_ROOT)
  .option('--all', 'Run all projects with ready tasks sequentially')
  .option('--yes', 'Skip confirmation prompts (for scheduled/unattended runs)')
  .option('-l, --limit <n>', 'Max agents to run in parallel (0 = unlimited)', '0')
  .option('-k, --api-key <key>', 'Anthropic API key (or set ANTHROPIC_API_KEY env)')
  .option('-b, --backend <backend>', 'Agent backend: auto (default), claude, copilot, sdk', 'auto')
  .action(async (projectName: string | undefined, opts: {
    root: string; all: boolean; yes: boolean; limit: string; apiKey?: string; backend: string
  }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? config.apiKey ?? ''
    const backend = (opts.backend ?? config.backend ?? 'auto') as 'auto' | 'claude' | 'copilot' | 'sdk'

    // No key needed if claude CLI is available (Claude Code VS Code extension)
    const projects = scanProjects(rootDir)
    const actionable = projects.filter(p => p.readyTasks.length + p.activeTasks.length > 0)

    if (actionable.length === 0) {
      console.log(chalk.yellow('No projects with ready tasks found.'))
      return
    }

    let targets = actionable
    if (!opts.all && projectName) {
      targets = actionable.filter(p =>
        p.name.toLowerCase().includes(projectName.toLowerCase())
      )
      if (targets.length === 0) {
        console.error(chalk.red(`No project matching "${projectName}"`))
        console.log('Available:', actionable.map(p => p.name).join(', '))
        process.exit(1)
      }
    } else if (!opts.all) {
      // Interactive pick
      console.log(chalk.bold('\nProjects with ready tasks:\n'))
      actionable.forEach((p, i) => {
        const top = getTopTask(p)
        console.log(`  ${i + 1}. ${chalk.bold(p.name)} - ${top ? `[${top[0]}] ${top[1].title}` : ''}`)
      })
      const idx = await promptNumber(`\nPick a project (1-${actionable.length}): `, 1, actionable.length)
      const picked = actionable[idx - 1]
      if (!picked) { process.exit(1); return }
      targets = [picked]
    }

    // When --all --yes: run all in parallel with live status board
    if (opts.all && opts.yes) {
      const maxConcurrent = parseInt(opts.limit, 10) || 0
      const limitLabel = maxConcurrent > 0 ? ` (max ${maxConcurrent} at a time)` : ' in parallel'
      console.log(chalk.bold(`\n🚀 Spawning ${targets.length} agents${limitLabel}...`))

      // Build status entries, one per target
      const statuses: AgentStatus[] = targets.map(p => {
        const top = getTopTask(p)
        return {
          repo: p.name,
          taskId: top?.[0] ?? '?',
          taskTitle: top?.[1].title ?? '',
          state: 'queued' as const,
          lastLine: '',
          logFile: agentLogPath(p.name),
          committed: false,
        }
      })

      const board = new StatusBoard(statuses)
      board.start()

      const results = await runWithLimit(targets, maxConcurrent, async project => {
        const topTask = getTopTask(project)
        if (!topTask) return undefined
        const [taskId, task] = topTask
        const st = statuses.find(s => s.repo === project.name)!

        st.state = 'running'
        st.startedAt = new Date()
        board.refresh()

        try {
          const result = await runAgent(project, taskId, task, apiKey, msg => {
            // Only update the last meaningful line for the status board (skip blanks)
            const line = msg.replace(/\x1B\[[0-9;]*m/g, '').split('\n').reverse().find(l => l.trim())
            if (line) st.lastLine = line.trim()
            board.refresh()
          }, backend)

          st.state = result.success ? 'done' : 'failed'
          st.committed = result.committed
          st.finishedAt = new Date()
          st.lastLine = result.success ? `committed` : 'no commit detected'
          board.refresh()
          return result
        } catch (err) {
          st.state = 'failed'
          st.finishedAt = new Date()
          st.lastLine = String(err).slice(0, 60)
          board.refresh()
          return undefined
        }
      })

      board.finish()

      // Show log file hints for any failures
      const failed = statuses.filter(s => s.state === 'failed')
      if (failed.length > 0) {
        console.log(chalk.gray('\nTo inspect failed agents:'))
        for (const s of failed) {
          console.log(chalk.gray(`  tail -f "${s.logFile}"`))
        }
      }
      return
    }

    // Sequential mode (single project or interactive)
    for (const project of targets) {
      const topTask = getTopTask(project)
      if (!topTask) continue
      const [taskId, task] = topTask

      if (!opts.yes) {
        const answer = await promptYN(
          `\nRun agent on ${chalk.bold(project.name)} → [${taskId}] ${task.title}? (y/n) `
        )
        if (!answer) { console.log(chalk.gray('Skipped.')); continue }
      }

      try {
        const result = await runAgent(project, taskId, task, apiKey, msg => console.log(chalk.gray(msg)), backend)

        if (result.success) {
          console.log(chalk.green(`\n✅ ${project.name} [${taskId}] completed in ${result.turns} turns`))
        } else {
          console.log(chalk.yellow(`\n⚠️  ${project.name} [${taskId}] finished without committing (${result.turns} turns)`))
          console.log(chalk.gray('   Check the output above - changes may need manual review'))
        }
      } catch (err) {
        console.error(chalk.red(`\n❌ Agent failed on ${project.name}: ${String(err)}`))
      }
    }
  })

// ── config ────────────────────────────────────────────────────────────────────

program
  .command('config')
  .description('Set persistent configuration (stored in ~/.aahp-runner.json)')
  .option('-r, --root <path>', 'Set root development folder')
  .option('-k, --api-key <key>', 'Set Anthropic API key')
  .option('-b, --backend <backend>', 'Set default backend: auto, claude, copilot, sdk')
  .action((opts: { root?: string; apiKey?: string; backend?: string }) => {
    if (opts.root) {
      saveConfig({ rootDir: opts.root })
      console.log(chalk.green(`✅ Root set to: ${opts.root}`))
    }
    if (opts.apiKey) {
      saveConfig({ apiKey: opts.apiKey })
      console.log(chalk.green('✅ API key saved to ~/.aahp-runner.json'))
    }
    if (opts.backend) {
      const valid = ['auto', 'claude', 'copilot', 'sdk']
      if (!valid.includes(opts.backend)) {
        console.error(chalk.red(`Invalid backend "${opts.backend}". Choose: ${valid.join(', ')}`))
        process.exit(1)
      }
      saveConfig({ backend: opts.backend as 'auto' | 'claude' | 'copilot' | 'sdk' })
      console.log(chalk.green(`✅ Default backend set to: ${opts.backend}`))
    }
    if (!opts.root && !opts.apiKey && !opts.backend) {
      const cfg = loadConfig()
      console.log(chalk.bold('\nCurrent config (~/.aahp-runner.json):'))
      console.log(`  root:      ${cfg.rootDir ?? '(not set - use AAHP_ROOT env or --root)'}`)
      console.log(`  apiKey:    ${cfg.apiKey ? '***set***' : '(not set - use ANTHROPIC_API_KEY env)'}`)
      console.log(`  backend:   ${cfg.backend ?? 'auto'}`)
      console.log(`  schedule:  ${cfg.scheduledTime ?? '(not scheduled)'}`)
    }
  })

// ── schedule ──────────────────────────────────────────────────────────────────

program
  .command('schedule')
  .description('Register a daily Windows Task Scheduler job to run all projects')
  .option('--time <HH:MM>', 'Time to run daily', '02:00')
  .option('-r, --root <path>', 'Root development folder')
  .action((opts: { time: string; root?: string }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    saveConfig({ scheduledTime: opts.time, rootDir })
    registerWindowsScheduler(opts.time, rootDir)
  })

// ── logs — tail an agent's log file ──────────────────────────────────────────

program
  .command('logs [repo]')
  .description('Show or tail the latest log for an agent. Omit repo to list all logs.')
  .option('-f, --follow', 'Stream log in real-time (like tail -f)')
  .option('-n, --lines <n>', 'Show last N lines', '40')
  .action(async (repo: string | undefined, opts: { follow: boolean; lines: string }) => {
    fs.mkdirSync(LOG_DIR, { recursive: true })

    if (!repo) {
      // List all log files
      const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).sort().reverse()
      if (files.length === 0) {
        console.log(chalk.gray(`No logs yet in ${LOG_DIR}`))
        console.log(chalk.gray('Logs are written when agents run via: aahp run --all --yes'))
        return
      }
      console.log(chalk.bold(`\n📋 Agent logs in ${LOG_DIR}\n`))
      for (const f of files) {
        const stat = fs.statSync(`${LOG_DIR}/${f}`)
        const size = (stat.size / 1024).toFixed(1)
        console.log(`  ${chalk.cyan(f.replace('.log', '').padEnd(40))} ${chalk.gray(`${size} KB`)}`)
      }
      console.log(chalk.gray(`\n  aahp logs <repo>        show last 40 lines`))
      console.log(chalk.gray(`  aahp logs <repo> -f     stream live`))
      return
    }

    // Find the latest log for this repo
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith(repo) && f.endsWith('.log'))
      .sort().reverse()

    if (files.length === 0) {
      console.log(chalk.yellow(`No log found for "${repo}"`))
      console.log(chalk.gray(`Available: ${fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).map(f => f.replace(/-\d{4}-\d{2}-\d{2}\.log$/, '')).join(', ')}`))
      return
    }

    const logPath = path.join(LOG_DIR, files[0]!)
    console.log(chalk.gray(`${logPath}\n`))

    if (opts.follow) {
      // Stream new content as it's written
      const n = parseInt(opts.lines, 10) || 40
      const content = fs.readFileSync(logPath, 'utf8')
      const lines = content.split('\n')
      process.stdout.write(lines.slice(-n).join('\n') + '\n')

      let size = fs.statSync(logPath).size
      console.log(chalk.cyan('--- following (Ctrl+C to stop) ---'))
      const interval = setInterval(() => {
        const newSize = fs.statSync(logPath).size
        if (newSize > size) {
          const fd = fs.openSync(logPath, 'r')
          const buf = Buffer.allocUnsafe(newSize - size)
          fs.readSync(fd, buf, 0, buf.length, size)
          fs.closeSync(fd)
          process.stdout.write(buf.toString())
          size = newSize
        }
      }, 300)
      process.on('SIGINT', () => { clearInterval(interval); process.exit(0) })
      // Keep running until Ctrl+C
      await new Promise(() => {})
    } else {
      // Just show last N lines
      const n = parseInt(opts.lines, 10) || 40
      const lines = fs.readFileSync(logPath, 'utf8').split('\n')
      const tail = lines.slice(-n)
      process.stdout.write(tail.join('\n') + '\n')
      if (lines.length > n) {
        console.log(chalk.gray(`\n  (showing last ${n} of ${lines.length} lines — use -f to follow or -n <N> for more)`))
      }
    }
  })

// ── status — live agents + MANIFEST overview ──────────────────────────────────

program
  .command('status')
  .description('Show live running agents and quick status overview')
  .option('-r, --root <path>', 'Root development folder', DEFAULT_ROOT)
  .option('-w, --watch', 'Refresh every 3 seconds (Ctrl+C to stop)')
  .action(async (opts: { root: string; watch: boolean }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT

    const print = (): void => {
      const live = readLiveSessions()
      const projects = scanProjects(rootDir)
      const liveNames = new Set(live.map(s => s.repoName ?? path.basename(s.repoPath)))

      // ── Live running agents section ─────────────────────────────────────────
      if (live.length > 0) {
        console.log(chalk.bold.cyan(`\n🔄 Running agents (${live.length})\n`))
        for (const s of live) {
          const name = (s.repoName ?? path.basename(s.repoPath)).padEnd(28)
          const task = chalk.yellow(`[${s.taskId ?? '?'}] ${(s.taskTitle ?? '').slice(0, 40)}`)
          const backend = chalk.gray(`(${s.backend ?? 'auto'})`)
          const elapsed = s.startedAt
            ? chalk.gray(Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000) + 's')
            : ''
          const lastLine = getLastLogLine(s.repoName ?? path.basename(s.repoPath))
          const hint = lastLine ? chalk.gray(' · ' + lastLine) : ''
          console.log(`  ${chalk.cyan('🔄')} ${chalk.white(name)} ${task} ${elapsed} ${backend}${hint}`)
        }
      } else {
        console.log(chalk.gray('\n  No agents currently running'))
        console.log(chalk.gray('  Start with: aahp run --all --yes\n'))
      }

      // ── Static MANIFEST overview ────────────────────────────────────────────
      console.log(chalk.bold(`\n📋 Project overview — ${rootDir}\n`))
      for (const p of projects) {
        const top = getTopTask(p)
        const isLive = liveNames.has(p.name)
        const phase = chalk.cyan(p.manifest.last_session.phase)
        const taskLine = top ? chalk.yellow(`[${top[0]}] ${top[1].title}`) : chalk.gray('all done')
        const indicator = isLive ? chalk.cyan(' 🔄') : '   '
        console.log(`${indicator} ${chalk.bold(p.name.padEnd(28))} ${phase.padEnd(20)} ${taskLine}`)
      }
      console.log()
    }

    if (opts.watch) {
      // Clear and reprint every 3s
      const draw = (): void => {
        process.stdout.write('\x1Bc')  // clear screen
        print()
        console.log(chalk.gray('  Refreshing every 3s — Ctrl+C to stop'))
      }
      draw()
      const interval = setInterval(draw, 3000)
      process.on('SIGINT', () => { clearInterval(interval); process.exit(0) })
      await new Promise(() => {})
    } else {
      print()
    }
  })

program
  .name('aahp')
  .description('Autonomous AAHP agent runner - spawns Claude or Copilot agents to work through project tasks')
  .version('0.1.0')
  .addHelpText('after', `
Backends:
  auto     Prefers Claude Code CLI, falls back to GitHub Copilot, then Anthropic SDK
  claude   Claude Code CLI only (requires VS Code Claude Code extension)
  copilot  GitHub Copilot only (requires: gh auth login with Copilot subscription)
  sdk      Anthropic API key only

Examples:
  aahp                               Guided setup - shows next step automatically
  aahp list                          See all projects and their top ready task
  aahp status                        Live agents + project overview
  aahp status -w                     Watch mode: refresh every 3s
  aahp run --all --yes               Spawn agents on ALL projects (auto backend)
  aahp run --all --yes --backend copilot    Use GitHub Copilot for all tasks
  aahp run --all --yes --backend claude     Use Claude Code for all tasks
  aahp run --all --yes --limit 3     Cap at 3 concurrent agents
  aahp run openclaw-ops              Spawn agent on one project
  aahp logs                          List all agent log files
  aahp logs openclaw-ops             Show last 40 lines of agent log
  aahp logs openclaw-ops -f          Stream agent log live (tail -f)
  aahp config --backend copilot      Save default backend
  aahp config --api-key sk-ant-...   Save Anthropic API key
  aahp schedule --time 02:00         Register nightly Windows Task Scheduler job
`)

// ── Default: guided wizard when no command given ──────────────────────────────

program.action(async () => {
  const config = loadConfig()
  const rootDir = config.rootDir ?? process.env['AAHP_ROOT'] ?? ''

  console.log(chalk.bold('\n🤖 AAHP Runner\n'))

  // ── Step 1: check root ───────────────────────────────────────────────────────
  if (!rootDir || rootDir === path.join(os.homedir(), 'Development')) {
    console.log(chalk.yellow('Step 1 of 3: Set your development root folder'))
    console.log(chalk.gray('  This is the folder containing all your repos.'))
    console.log()
    console.log(chalk.white('  Run:') + chalk.cyan(`  aahp config --root "E:\\_nextcloud.weloveselfmade.com\\_Data\\_Development"`))
    console.log()
    return
  }
  console.log(chalk.green('✅ Root:') + chalk.gray(` ${rootDir}`))

  // ── Step 2: check claude CLI ─────────────────────────────────────────────────
  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'
  const { code: claudeCode } = await runAsync(claudeCmd, ['--version'], process.cwd(), 10000)
  const claudeOk = claudeCode === 0

  if (!claudeOk) {
    console.log(chalk.yellow('\nStep 2 of 3: Install Claude Code'))
    console.log(chalk.gray('  Claude Code is the agent engine. Install it in VS Code:'))
    console.log()
    console.log(chalk.white('  1.') + ' Open VS Code Extensions → search "Claude Code" → Install')
    console.log(chalk.white('  2.') + ' Sign in when prompted')
    console.log(chalk.white('  3.') + ' Then run: ' + chalk.cyan('aahp'))
    console.log()
    return
  }
  console.log(chalk.green('✅ Claude Code CLI detected'))

  // ── Step 3: scan projects ────────────────────────────────────────────────────
  const projects = scanProjects(rootDir)
  const actionable = projects.filter(p => p.readyTasks.length + p.activeTasks.length > 0)

  if (projects.length === 0) {
    console.log(chalk.yellow('\nStep 3 of 3: Add AAHP v3 handoff files to your repos'))
    console.log(chalk.gray('  No repos with .ai/handoff/MANIFEST.json found in:'))
    console.log(chalk.gray(`  ${rootDir}`))
    console.log()
    console.log(chalk.white('  See:') + chalk.cyan('  https://github.com/homeofe/AAHP'))
    console.log()
    return
  }
  console.log(chalk.green(`✅ ${projects.length} AAHP projects found - ${actionable.length} with ready tasks`))

  if (actionable.length === 0) {
    console.log(chalk.gray('\n  All tasks are done or blocked. Nothing to run.'))
    console.log(chalk.gray('  Add new tasks to a MANIFEST.json to get started.'))
    return
  }

  // ── All good: show what's ready and the exact command ────────────────────────
  console.log(chalk.bold('\n📋 Ready to run:\n'))
  for (const p of actionable) {
    const top = getTopTask(p)
    if (!top) continue
    const [id, task] = top
    const priorityColor = task.priority === 'high' ? chalk.red : task.priority === 'medium' ? chalk.yellow : chalk.cyan
    console.log(`  ${chalk.bold(p.name.padEnd(28))} ${priorityColor(`[${id}]`)} ${task.title}`)
  }

  console.log()
  console.log(chalk.bold('▶ Next command:'))
  console.log()
  console.log('  ' + chalk.bgCyan(chalk.black(' aahp run --all --yes ')) + chalk.gray('  ← spawn all agents in parallel'))
  console.log('  ' + chalk.gray('aahp run --all --yes --limit 5') + chalk.gray('  ← cap at 5 agents at a time'))
  console.log()
  console.log(chalk.gray('  Or pick one repo:'))
  for (const p of actionable.slice(0, 3)) {
    console.log(chalk.gray(`    aahp run ${p.name}`))
  }
  if (actionable.length > 3) {
    console.log(chalk.gray(`    … and ${actionable.length - 3} more`))
  }
  console.log()
  console.log(chalk.gray('  Schedule nightly runs:'))
  console.log(chalk.gray('    aahp schedule --time 02:00'))
  console.log()
})

program.parse()

// ── helpers ───────────────────────────────────────────────────────────────────

/** Sliding-window concurrency limiter. maxConcurrent=0 - all in parallel. */
async function runWithLimit<T, R>(
  items: T[],
  maxConcurrent: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (maxConcurrent <= 0 || maxConcurrent >= items.length) {
    return Promise.all(items.map(fn))
  }

  const results: R[] = []
  const queue = [...items.entries()]
  let active = 0
  let errored = false

  await new Promise<void>((resolve, reject) => {
    const next = () => {
      if (errored) return
      if (queue.length === 0 && active === 0) { resolve(); return }
      while (active < maxConcurrent && queue.length > 0 && !errored) {
        const entry = queue.shift()!
        const [idx, item] = entry
        active++
        fn(item).then(r => {
          results[idx] = r
          active--
          next()
        }).catch(err => {
          active--
          errored = true
          reject(err)
          // Don't call next() after rejection - let remaining tasks complete
          // but don't start new ones
        })
      }
    }
    next()
  })

  return results
}

function promptNumber(question: string, min: number, max: number): Promise<number> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      const n = parseInt(answer.trim(), 10)
      resolve(isNaN(n) || n < min || n > max ? min : n)
    })
  })
}

function promptYN(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase().startsWith('y'))
    })
  })
}
