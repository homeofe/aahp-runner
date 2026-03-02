#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import * as path from 'path'
import * as fs from 'fs'
import os from 'os'
import * as readline from 'readline'
import { scanProjects, scanProjectByPath, bootstrapProject, scanAllGitRepos, getTopTask } from './scanner.js'
import { runAgent, runPlanningAgent } from './agent.js'
import { runAsync } from './tools.js'
import { loadConfig, saveConfig, registerScheduler, unregisterScheduler } from './scheduler.js'
import { StatusBoard, AgentStatus, LOG_DIR, agentLogPath, writeLog } from './status-board.js'
import { recordMetric, loadMetrics, summarizeMetrics, metricsFilePath, getAvgDuration } from './metrics-store.js'
import { sendAlert } from './alerting.js'
import { execSync } from 'child_process'

const DEFAULT_ROOT= process.env['AAHP_ROOT'] ?? path.join(os.homedir(), 'Development')

/** Read ~/.aahp/sessions.json written by aahp-orchestrator SessionMonitor or aahp-runner */
function readLiveSessions(): Array<{ repoPath: string; repoName: string; taskId: string; taskTitle: string; backend: string; startedAt: string }> {
  const lockFile = path.join(os.homedir(), '.aahp', 'sessions.json')
  try {
    if (!fs.existsSync(lockFile)) return []
    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { sessions?: unknown[] }
    return Array.isArray(data.sessions) ? data.sessions as ReturnType<typeof readLiveSessions> : []
  } catch { return [] }
}

/**
 * Commit any dirty handoff metadata files (.ai/handoff/, .gitignore) in each
 * project directory and push. Called after planning rounds and initial runs so
 * that MANIFEST.json / NEXT_ACTIONS.md updates are never left uncommitted.
 */
function commitHandoffState(projectPaths: string[], label = 'aahp-runner scan'): void {
  for (const dir of projectPaths) {
    try {
      const dirty = execSync('git status --porcelain -- .ai/handoff .gitignore', { cwd: dir, stdio: 'pipe' }).toString().trim()
      if (!dirty) continue
      execSync('git add .ai/handoff .gitignore', { cwd: dir, stdio: 'pipe' })
      execSync(
        `git commit -m "chore: update handoff state (${label})\n\nAuto-committed MANIFEST.json / NEXT_ACTIONS.md updates from\naahp-runner GitHub issue sync and planning.\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"`,
        { cwd: dir, stdio: 'pipe' }
      )
      try { execSync('git push', { cwd: dir, stdio: 'pipe' }) } catch { /* push failure is non-fatal */ }
    } catch { /* repo may have nothing to commit or unrelated changes */ }
  }
}

/** Read last line from today's agent log for a repo */
function getLastLogLine(repoName: string, repoPath?: string): string {
  try {
    const stamp = new Date().toISOString().slice(0, 10)
    // Prefer per-repo .ai/logs/ first, fall back to ~/.aahp/logs/
    const candidates = repoPath
      ? [path.join(repoPath, '.ai', 'logs', `${stamp}.log`),
         path.join(os.homedir(), '.aahp', 'logs', `${repoName}-${stamp}.log`)]
      : [path.join(os.homedir(), '.aahp', 'logs', `${repoName}-${stamp}.log`)]
    const logPath = candidates.find(p => fs.existsSync(p))
    if (!logPath) return ''
    const content = fs.readFileSync(logPath, 'utf8')
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('='))
    const last = lines[lines.length - 1] ?? ''
    return last.replace(/\s+/g, ' ').slice(0, 50)
  } catch { return '' }
}

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List AAHP projects that have actionable tasks')
  .option('-r, --root <path>', 'Root development folder', DEFAULT_ROOT)
  .option('-a, --all', 'Show every task per project (with GitHub issue links)')
  .action((opts: { root: string; all: boolean }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const projects = scanProjects(rootDir)

    if (projects.length === 0) {
      console.log(chalk.yellow(`No AAHP projects found in ${rootDir}`))
      console.log(chalk.gray('Make sure repos have .ai/handoff/MANIFEST.json'))
      return
    }

    const displayProjects = opts.all ? projects : projects.filter(p =>
      p.readyTasks.length + p.activeTasks.length + p.blockedTasks.length + p.cancelledTasks.length > 0
    )

    const totalTasks = projects.reduce((n, p) =>
      n + p.readyTasks.length + p.activeTasks.length + p.blockedTasks.length + p.cancelledTasks.length, 0)
    const idleCount = projects.filter(p =>
      p.readyTasks.length + p.activeTasks.length + p.blockedTasks.length + p.cancelledTasks.length === 0
    ).length

    if (displayProjects.length === 0) {
      console.log(chalk.green('\n✅ All projects are up to date - no actionable tasks'))
      console.log(chalk.gray(`   ${projects.length} projects scanned · use --all to show them`))
      return
    }

    const ICON: Record<string, string> = {
      in_progress: '🔄', ready: '⏳', blocked: '🚫', done: '✅', cancelled: '🚫',
    }

    const termWidth = process.stdout.columns || 120

    if (opts.all) {
      // ── Expanded mode: one sub-row per task with GitHub issue link ────────
      const W_NAME  = Math.min(28, Math.max(12, ...displayProjects.map(p => p.name.length)))
      const W_PHASE = Math.min(14, Math.max(5,  ...displayProjects.map(p => (p.manifest.last_session.phase ?? '').length)))
      const W_ID    = 6   // T-NNN
      const W_PRI   = 3   // hig/med/low
      const W_GH    = 6   // #12345
      // title gets remaining width
      const W_TITLE = Math.max(20, termWidth - W_NAME - W_PHASE - W_ID - W_PRI - W_GH - 18)

      const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s
      const cell  = (s: string, w: number) => trunc(s, w).padEnd(w)

      const divider = (l: string, m: string, r: string) =>
        chalk.gray(
          l + '─'.repeat(W_NAME + 2) + m + '─'.repeat(W_PHASE + 2) + m +
          '─'.repeat(W_ID + 2) + m + '─'.repeat(W_PRI + 2) + m +
          '─'.repeat(W_TITLE + 2) + m + '─'.repeat(W_GH + 2) + r
        )

      const totalShown = displayProjects.reduce((n, p) =>
        n + Math.max(1, p.readyTasks.length + p.activeTasks.length + p.blockedTasks.length), 0)

      console.log(chalk.bold(`\n📋 AAHP  ·  ${projects.length} projects · ${totalTasks} tasks\n`))
      console.log(divider('┌', '┬', '┐'))
      console.log(
        chalk.gray('│ ') + chalk.bold(cell('Project', W_NAME)) +
        chalk.gray(' │ ') + chalk.bold(cell('Phase', W_PHASE)) +
        chalk.gray(' │ ') + chalk.bold(cell('ID', W_ID)) +
        chalk.gray(' │ ') + chalk.bold(cell('Pri', W_PRI)) +
        chalk.gray(' │ ') + chalk.bold(cell('Task', W_TITLE)) +
        chalk.gray(' │ ') + chalk.bold(cell('Issue', W_GH)) +
        chalk.gray(' │')
      )
      console.log(divider('├', '┼', '┤'))

      for (let pi = 0; pi < displayProjects.length; pi++) {
        const project = displayProjects[pi]!
        const phase = project.manifest.last_session.phase ?? ''
        const taskRows = [
          ...project.activeTasks,
          ...project.readyTasks,
          ...project.blockedTasks,
        ] as Array<[string, import('./types.js').AahpTask]>

        if (taskRows.length === 0) {
          // idle project
          console.log(
            chalk.gray('│ ') + chalk.gray(cell(project.name, W_NAME)) +
            chalk.gray(' │ ') + chalk.gray(cell(phase, W_PHASE)) +
            chalk.gray(' │ ') + chalk.gray(cell('', W_ID)) +
            chalk.gray(' │ ') + chalk.gray(cell('', W_PRI)) +
            chalk.gray(' │ ') + chalk.green(cell('✅ idle — no open tasks', W_TITLE)) +
            chalk.gray(' │ ') + chalk.gray(cell('', W_GH)) +
            chalk.gray(' │')
          )
        } else {
          for (let ti = 0; ti < taskRows.length; ti++) {
            const [taskId, task] = taskRows[ti]!
            const isFirst = ti === 0
            // Only print project name and phase on the first task row
            const nameStr  = isFirst ? project.name : ''
            const phaseStr = isFirst ? phase : ''
            const icon  = ICON[task.status] ?? '•'
            const pri   = task.priority.slice(0, 3)
            const gh    = task.github_issue ? `#${task.github_issue}` : ''
            const title = `${icon} ${task.title}`

            const nameColored  = isFirst
              ? (project.activeTasks.length > 0 ? chalk.white.bold : chalk.white)(cell(nameStr, W_NAME))
              : chalk.gray(cell(nameStr, W_NAME))
            const phaseColored = chalk.cyan(cell(phaseStr, W_PHASE))
            const idColored    = chalk.yellow(cell(taskId, W_ID))
            const priColored   =
              task.priority === 'high'   ? chalk.red(cell(pri, W_PRI)) :
              task.priority === 'medium' ? chalk.yellow(cell(pri, W_PRI)) :
              chalk.gray(cell(pri, W_PRI))
            const titleColored =
              task.status === 'blocked' ? chalk.gray(cell(title, W_TITLE)) :
              task.status === 'in_progress' ? chalk.white(cell(title, W_TITLE)) :
              chalk.white(cell(title, W_TITLE))
            const ghColored    = gh ? chalk.blue(cell(gh, W_GH)) : chalk.gray(cell('', W_GH))

            console.log(
              chalk.gray('│ ') + nameColored +
              chalk.gray(' │ ') + phaseColored +
              chalk.gray(' │ ') + idColored +
              chalk.gray(' │ ') + priColored +
              chalk.gray(' │ ') + titleColored +
              chalk.gray(' │ ') + ghColored +
              chalk.gray(' │')
            )
          }
        }

        // Separator between projects (not after last)
        if (pi < displayProjects.length - 1) {
          console.log(divider('├', '┼', '┤'))
        }
      }

      console.log(divider('└', '┴', '┘'))
      console.log(chalk.gray(`\n  ${projects.length} projects · `) + chalk.yellow(String(totalTasks)) + chalk.gray(` tasks total`))
      if (idleCount > 0) console.log(chalk.gray(`  ${idleCount} idle (no open tasks)`))
      console.log(chalk.gray(`  aahp run --all --yes   to start all agents`))
      console.log()
      return
    }

    // ── Default mode: one row per project, top task only (unchanged) ─────────
    const actionable = displayProjects
    const W_NAME  = Math.min(30, Math.max(12, ...actionable.map(p => p.name.length)))
    const W_PHASE = Math.min(16, Math.max(5,  ...actionable.map(p => (p.manifest.last_session.phase ?? '').length)))
    const W_CNT   = 5
    const W_TASK  = Math.max(20, termWidth - W_NAME - W_PHASE - W_CNT - 13)

    const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s
    const cell  = (s: string, w: number) => trunc(s, w).padEnd(w)

    const divider = (l: string, m: string, r: string) =>
      chalk.gray(l + '─'.repeat(W_NAME + 2) + m + '─'.repeat(W_PHASE + 2) + m +
        '─'.repeat(W_CNT + 2) + m + '─'.repeat(W_TASK + 2) + r)

    const headerRow =
      chalk.gray('│ ') + chalk.bold(cell('Project', W_NAME)) +
      chalk.gray(' │ ') + chalk.bold(cell('Phase', W_PHASE)) +
      chalk.gray(' │ ') + chalk.bold(cell('Tasks', W_CNT)) +
      chalk.gray(' │ ') + chalk.bold(cell('Top Task', W_TASK)) +
      chalk.gray(' │')

    console.log(chalk.bold(`\n📋 AAHP  ·  ${actionable.length} project${actionable.length !== 1 ? 's' : ''} with tasks\n`))
    console.log(divider('┌', '┬', '┐'))
    console.log(headerRow)
    console.log(divider('├', '┼', '┤'))

    for (const project of actionable) {
      const topTask  = getTopTask(project)
      const taskCount = project.readyTasks.length + project.activeTasks.length + project.blockedTasks.length + project.cancelledTasks.length
      const phase    = project.manifest.last_session.phase ?? ''
      const isActive = project.activeTasks.length > 0

      let taskStr = ''
      if (topTask) {
        const [id, task] = topTask
        const icon   = ICON[task.status] ?? '•'
        const pri    = task.priority.slice(0, 3)
        const gh     = task.github_issue ? ` #${task.github_issue}` : ''
        const titleBudget = W_TASK - id.length - pri.length - gh.length - 6
        const title  = trunc(task.title, Math.max(8, titleBudget))
        taskStr = `${icon} ${id} (${pri}) ${title}${gh}`
      }

      const nameCell  = cell(project.name, W_NAME)
      const phaseCell = cell(phase, W_PHASE)
      const cntCell   = cell(String(taskCount), W_CNT)
      const taskCell  = cell(taskStr, W_TASK)

      const nameColored  = (isActive ? chalk.white.bold : chalk.white)(nameCell)
      const phaseColored = chalk.cyan(phaseCell)
      const cntColored   = chalk.yellow(cntCell)

      console.log(
        chalk.gray('│ ') + nameColored +
        chalk.gray(' │ ') + phaseColored +
        chalk.gray(' │ ') + cntColored +
        chalk.gray(' │ ') + taskCell +
        chalk.gray(' │')
      )
    }

    console.log(divider('└', '┴', '┘'))

    const idleNote = idleCount > 0 ? chalk.gray(` · ${idleCount} idle hidden (--all)`) : ''
    console.log(chalk.gray(`\n  ${actionable.length} projects · `) + chalk.yellow(String(totalTasks)) + chalk.gray(` tasks${idleNote}`))
    console.log(chalk.gray(`  aahp run --all --yes   to start all agents`))
    console.log()
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
  .option('-t, --timeout <minutes>', 'Per-agent timeout in minutes (default: 10)', '10')
  .option('--follow-up', 'After completing tasks, auto-plan idle repos and run new tasks (chains until done)')
  .action(async (projectName: string | undefined, opts: {
    root: string; all: boolean; yes: boolean; limit: string; apiKey?: string; backend: string; timeout: string; followUp: boolean
  }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? config.apiKey ?? ''
    const backend = (opts.backend ?? config.backend ?? 'auto') as 'auto' | 'claude' | 'copilot' | 'sdk'
    const timeoutMinutes = parseInt(opts.timeout, 10) || config.timeoutMinutes || 10

    // No key needed if claude CLI is available (Claude Code VS Code extension)
    const projects = scanProjects(rootDir)
    // run only operates on ready/active tasks - blocked tasks need manual intervention
    const actionable = projects.filter(p => p.readyTasks.length + p.activeTasks.length > 0)

    if (actionable.length === 0) {
      const blocked = projects.filter(p => p.blockedTasks.length > 0)
      if (blocked.length > 0) {
        console.log(chalk.yellow(`\nNo ready tasks. ${blocked.length} repo(s) have blocked tasks (need manual action):`))
        for (const p of blocked) {
          const ids = p.blockedTasks.map(([id]) => id).join(', ')
          console.log(chalk.gray(`  ${p.name}: ${ids} — ${p.blockedTasks[0]?.[1]?.title ?? ''}`))
        }
        console.log(chalk.gray('\n  Use `aahp list` to inspect · unblock in MANIFEST.json or close the GitHub issue'))
      } else {
        console.log(chalk.green('\n✅ All projects are up to date — no actionable tasks'))
      }
      return
    }

    // Show blocked projects being skipped (so user knows why count differs from aahp list)
    const skippedBlocked = projects.filter(p =>
      p.readyTasks.length === 0 && p.activeTasks.length === 0 && p.blockedTasks.length > 0
    )
    if (skippedBlocked.length > 0 && opts.all) {
      console.log(chalk.gray(`\n  Note: skipping ${skippedBlocked.length} repo(s) with only blocked tasks: ${skippedBlocked.map(p => p.name).join(', ')}`))
    }

    let targets = actionable
    if (!opts.all && projectName) {
      targets = actionable.filter(p =>
        p.name.toLowerCase().includes(projectName.toLowerCase())
      )
      if (targets.length === 0) {
        // Project not in actionable pool — check if it exists but has no MANIFEST.json yet
        const candidate = fs.readdirSync(rootDir, { withFileTypes: true })
          .find(e => (e.isDirectory() || e.isSymbolicLink()) &&
            e.name.toLowerCase().includes(projectName.toLowerCase()))
        if (candidate) {
          const candidatePath = path.join(rootDir, candidate.name)
          if (fs.existsSync(path.join(candidatePath, '.git'))) {
            console.log(chalk.gray(`\n  Bootstrapping ${candidate.name} (no MANIFEST.json yet) ...`))
            const bootstrapped = bootstrapProject(candidatePath)
            if (bootstrapped && (bootstrapped.readyTasks.length + bootstrapped.activeTasks.length > 0)) {
              targets = [bootstrapped]
            } else if (bootstrapped) {
              console.log(chalk.yellow(`  ${candidate.name} has no ready tasks after GitHub sync.`))
              process.exit(0)
            }
          }
        }
        if (targets.length === 0) {
          console.error(chalk.red(`No project matching "${projectName}"`))
          console.log('Available:', [...actionable.map(p => p.name)].join(', '))
          process.exit(1)
        }
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
          logFile: agentLogPath(p.name, p.repoPath),
          committed: false,
        }
      })

      const board = new StatusBoard(statuses)
      board.start()

      // Tick every second so the elapsed timer updates even between agent callbacks
      const ticker = setInterval(() => board.refresh(), 1000)

      const results = await runWithLimit(targets, maxConcurrent, async project => {
        const topTask = getTopTask(project)
        if (!topTask) return undefined
        const [taskId, task] = topTask
        const st = statuses.find(s => s.repo === project.name)!

        st.state = 'running'
        st.startedAt = new Date()

        // Set ETA from historical average
        const avgMs = getAvgDuration(project.name)
        if (avgMs) {
          st.estimatedEndAt = new Date(Date.now() + avgMs)
        }

        board.refresh()

        try {
          // Security pre-run guard (non-blocking if secure-dev-ai not installed)
          try {
            const secureDevAi = path.join(DEFAULT_ROOT, 'secure-dev-ai', 'dist', 'cli.js')
            if (fs.existsSync(secureDevAi)) {
              const guardResult = await runAsync('node', [secureDevAi, 'guard', '--pre', '--project', project.name], project.repoPath, 30000)
              if (guardResult.code === 1) {
                st.state = 'failed'
                st.finishedAt = new Date()
                st.lastLine = 'blocked by secure-dev-ai (CRITICAL findings)'
                board.refresh()
                return { success: false, committed: false, turns: 0, taskId, summary: 'blocked by secure-dev-ai (CRITICAL findings)', logFile: '' }
              }
            }
          } catch {
            // secure-dev-ai scan failed - continue without blocking
          }

          const result = await runAgent(project, taskId, task, apiKey, msg => {
            // Only update the last meaningful line for the status board (skip blanks)
            const line = msg.replace(/\x1B\[[0-9;]*m/g, '').split('\n').reverse().find(l => l.trim())
            if (line) st.lastLine = line.trim()

            // Extract turn progress from SDK/Copilot output (e.g., "-- Turn 5/30 --")
            const turnMatch = msg.match(/Turn (\d+)\/(\d+)/)
            if (turnMatch) {
              st.currentTurn = parseInt(turnMatch[1]!, 10)
              st.maxTurns = parseInt(turnMatch[2]!, 10)
            }

            board.refresh()
          }, backend, timeoutMinutes)

          st.state = result.success ? 'done' : 'failed'
          st.committed = result.committed
          st.finishedAt = new Date()
          st.lastLine = result.success ? `committed` : 'no commit detected'
          board.refresh()

          recordMetric({
            timestamp: new Date().toISOString(),
            repo: project.name,
            taskId,
            taskTitle: task.title,
            backend,
            durationMs: st.finishedAt.getTime() - (st.startedAt?.getTime() ?? st.finishedAt.getTime()),
            turns: result.turns,
            success: result.success,
            committed: result.committed,
            cpuAvg: result.cpuAvg,
            memPeakMB: result.memPeakMB,
          })

          return result
        } catch (err) {
          st.state = 'failed'
          st.finishedAt = new Date()
          st.lastLine = String(err).slice(0, 60)
          board.refresh()

          recordMetric({
            timestamp: new Date().toISOString(),
            repo: project.name,
            taskId,
            taskTitle: task.title,
            backend,
            durationMs: st.finishedAt.getTime() - (st.startedAt?.getTime() ?? st.finishedAt.getTime()),
            turns: 0,
            success: false,
            committed: false,
          })

          return undefined
        }
      })

      clearInterval(ticker)
      board.finish()

      // Send alerts for failed agents
      const failedStatuses = statuses.filter(s => s.state === 'failed')
      const doneStatuses = statuses.filter(s => s.state === 'done')
      for (const s of failedStatuses) {
        sendAlert(config.alerts, 'agent_failed', {
          repo: s.repo,
          taskId: s.taskId,
          success: false,
          summary: s.lastLine,
        })
      }

      // Send all_done alert
      sendAlert(config.alerts, 'all_done', {
        totalDone: doneStatuses.length,
        totalFailed: failedStatuses.length,
        summary: `${doneStatuses.length} committed, ${failedStatuses.length} failed`,
      })

      // Show log file hints for any failures
      if (failedStatuses.length > 0) {
        console.log(chalk.gray('\nTo inspect failed agents:'))
        for (const s of failedStatuses) {
          console.log(chalk.gray(`  aahp logs ${s.repo}`))
        }
      }

      // Commit any handoff metadata (MANIFEST.json, NEXT_ACTIONS.md) that was
      // updated by scanProjects() / GitHub issue sync but never committed.
      commitHandoffState(targets.map(p => p.repoPath), 'aahp-runner run')

      // Show remaining tasks across all repos (so user knows what's left)
      if (!opts.followUp) {
        const afterScan = scanProjects(rootDir)
        const remaining = afterScan.filter(p => p.readyTasks.length + p.activeTasks.length > 0)
        const remainingTaskCount = remaining.reduce((n, p) => n + p.readyTasks.length + p.activeTasks.length, 0)
        if (remaining.length > 0) {
          console.log(chalk.yellow(`\n  ${remainingTaskCount} task(s) still ready across ${remaining.length} repo(s)`))
          for (const p of remaining) {
            const ids = [...p.activeTasks, ...p.readyTasks].map(([id]) => id).join(', ')
            console.log(chalk.gray(`    ${p.name}: ${ids}`))
          }
          console.log(chalk.gray(`\n  Run again to continue, or use --follow-up to chain automatically`))
        }
      }

      // ── Follow-up: plan idle repos and re-run remaining tasks ─────────────
      if (opts.followUp) {
        let followRound = 0
        const MAX_FOLLOW_ROUNDS = 20
        while (followRound < MAX_FOLLOW_ROUNDS) {
          followRound++
          // Find repos that just became idle (completed their last task, no blocked-only limbo)
          const freshScan = scanProjects(rootDir)
          const nowIdle = freshScan.filter(p =>
            p.readyTasks.length === 0 && p.activeTasks.length === 0 && p.blockedTasks.length === 0
          )
          // Also find any repos that still have ready tasks (more to run)
          const stillActionable = freshScan.filter(p =>
            p.readyTasks.length + p.activeTasks.length > 0
          )

          if (nowIdle.length === 0 && stillActionable.length === 0) {
            console.log(chalk.green('\n✅ Follow-up complete — no more tasks or idle repos'))
            break
          }

          // Plan idle repos (only if there are any - don't block on this if there aren't)
          if (nowIdle.length > 0) {
            console.log(chalk.bold(`\n📐 Follow-up round ${followRound}: planning ${nowIdle.length} idle repo(s)...`))
            for (const p of nowIdle) {
              try {
                const result = await runPlanningAgent(p, apiKey, (msg) => {
                  const line = msg.replace(/\x1B\[[0-9;]*m/g, '').split('\n').reverse().find(l => l.trim())
                  if (line) process.stdout.write(chalk.gray(`\x1b[2K\r  [${p.name}] ${line.slice(0, 80)}`))
                }, backend, 2)
                process.stdout.write('\n')
                if (result.success) {
                  scanProjectByPath(p.repoPath)
                  console.log(chalk.green(`  ✅ ${p.name}: planned`))
                } else {
                  console.log(chalk.gray(`  ⏭ ${p.name}: no new tasks generated`))
                }
              } catch (err) {
                process.stdout.write('\n')
                console.log(chalk.red(`  ❌ ${p.name}: planning failed — ${(err as Error).message}`))
              }
            }
          }

          // Commit handoff metadata written by planning agent and scanProjects()
          if (nowIdle.length > 0) {
            commitHandoffState(nowIdle.map(p => p.repoPath), `aahp-runner follow-up round ${followRound}`)
          }

          // Re-scan and run ALL repos with actionable tasks (planned + pre-existing remaining)
          const nextRound = scanProjects(rootDir).filter(p =>
            p.readyTasks.length + p.activeTasks.length > 0
          )
          if (nextRound.length === 0) {
            console.log(chalk.green('\n✅ Follow-up complete — all repos idle'))
            break
          }

          const nextTaskCount = nextRound.reduce((n, p) => n + p.readyTasks.length + p.activeTasks.length, 0)
          console.log(chalk.bold(`\n🚀 Follow-up round ${followRound}: running ${nextTaskCount} task(s) across ${nextRound.length} repo(s)...`))
          const maxConcurrent2 = parseInt(opts.limit, 10) || 0
          const followStatuses: AgentStatus[] = nextRound.map(p => {
            const top = getTopTask(p)
            return { repo: p.name, taskId: top?.[0] ?? '?', taskTitle: top?.[1]?.title ?? '',
              state: 'queued' as const, lastLine: '', logFile: agentLogPath(p.name, p.repoPath), committed: false }
          })
          const followBoard = new StatusBoard(followStatuses)
          followBoard.start()
          const followTicker = setInterval(() => followBoard.refresh(), 1000)

          await runWithLimit(nextRound, maxConcurrent2, async project => {
            const top = getTopTask(project)
            if (!top) return undefined
            const [fTaskId, fTask] = top
            const fSt = followStatuses.find(s => s.repo === project.name)!
            fSt.state = 'running'
            fSt.startedAt = new Date()
            followBoard.refresh()
            try {
              const result = await runAgent(project, fTaskId, fTask, apiKey, msg => {
                const line = msg.replace(/\x1B\[[0-9;]*m/g, '').split('\n').reverse().find(l => l.trim())
                if (line) fSt.lastLine = line.trim()
                followBoard.refresh()
              }, backend, timeoutMinutes)
              fSt.state = result.committed ? 'done' : 'failed'
              fSt.committed = result.committed
              fSt.finishedAt = new Date()
              fSt.lastLine = result.committed ? 'committed' : 'no commit'
              followBoard.refresh()
              recordMetric({ timestamp: new Date().toISOString(), repo: project.name, taskId: fTaskId,
                taskTitle: fTask.title, backend,
                durationMs: (fSt.finishedAt?.getTime() ?? 0) - (fSt.startedAt?.getTime() ?? 0),
                turns: result.turns, success: result.committed, committed: result.committed })
              return result
            } catch (err) {
              fSt.state = 'failed'
              fSt.finishedAt = new Date()
              fSt.lastLine = String(err).slice(0, 60)
              followBoard.refresh()
              return undefined
            }
          })

          clearInterval(followTicker)
          followBoard.finish()

          // Commit handoff metadata updated by agents and post-run scanProjects()
          commitHandoffState(nextRound.map(p => p.repoPath), `aahp-runner follow-up round ${followRound}`)
        }
      }

      return
    }

    // Sequential mode (single project or interactive)
    // When --follow-up is set, keep looping until no more tasks remain in any of the target repos.
    const seqProjectNames = new Set(targets.map(p => p.name))
    let seqRound = 0
    const MAX_SEQ_ROUNDS = 50
    // eslint-disable-next-line no-constant-condition
    while (true) {
      seqRound++
      if (seqRound > MAX_SEQ_ROUNDS) {
        console.log(chalk.yellow(`\n⚠️  Reached follow-up limit (${MAX_SEQ_ROUNDS} rounds). Stopping.`))
        break
      }

      // Re-scan on every round so completed tasks are reflected
      const seqScan = scanProjects(rootDir).filter(p => seqProjectNames.has(p.name))
      const seqTargets = seqScan.filter(p => p.readyTasks.length + p.activeTasks.length > 0)

      if (seqTargets.length === 0) {
        // All target repos are idle — if follow-up, try planning them
        if (opts.followUp) {
          const idleTargets = seqScan.filter(p => p.blockedTasks.length === 0)
          if (idleTargets.length > 0) {
            console.log(chalk.bold(`\n📐 Follow-up: planning ${idleTargets.length} idle repo(s)...`))
            for (const p of idleTargets) {
              try {
                const result = await runPlanningAgent(p, apiKey, (msg) => {
                  const line = msg.replace(/\x1B\[[0-9;]*m/g, '').split('\n').reverse().find(l => l.trim())
                  if (line) process.stdout.write(chalk.gray(`\x1b[2K\r  [${p.name}] ${line.slice(0, 80)}`))
                }, backend, 2)
                process.stdout.write('\n')
                if (result.success) {
                  scanProjectByPath(p.repoPath)
                  console.log(chalk.green(`  ✅ ${p.name}: planned`))
                } else {
                  console.log(chalk.gray(`  ⏭ ${p.name}: no new tasks generated`))
                }
              } catch (err) {
                process.stdout.write('\n')
                console.log(chalk.red(`  ❌ ${p.name}: planning failed — ${(err as Error).message}`))
              }
            }
            commitHandoffState(idleTargets.map(p => p.repoPath), 'aahp-runner follow-up (sequential)')
            // Check again after planning
            const afterPlan = scanProjects(rootDir).filter(p => seqProjectNames.has(p.name) && p.readyTasks.length + p.activeTasks.length > 0)
            if (afterPlan.length === 0) {
              console.log(chalk.green('\n✅ Follow-up complete — all repos idle'))
              break
            }
            continue // run newly planned tasks
          }
        }
        if (seqRound === 1) {
          console.log(chalk.green('\n✅ All projects are up to date — no actionable tasks'))
        } else {
          console.log(chalk.green('\n✅ Follow-up complete — no more tasks'))
        }
        break
      }

      for (const project of seqTargets) {
        const topTask = getTopTask(project)
        if (!topTask) continue
        const [taskId, task] = topTask

        if (!opts.yes) {
          const answer = await promptYN(
            `\nRun agent on ${chalk.bold(project.name)} → [${taskId}] ${task.title}? (y/n) `
          )
          if (!answer) { console.log(chalk.gray('Skipped.')); continue }
        }

        const seqStart = Date.now()
        try {
          const result = await runAgent(project, taskId, task, apiKey, msg => console.log(chalk.gray(msg)), backend, timeoutMinutes)

          recordMetric({
            timestamp: new Date().toISOString(),
            repo: project.name,
            taskId,
            taskTitle: task.title,
            backend,
            durationMs: Date.now() - seqStart,
            turns: result.turns,
            success: result.success,
            committed: result.committed,
            cpuAvg: result.cpuAvg,
            memPeakMB: result.memPeakMB,
          })

          if (result.success) {
            console.log(chalk.green(`\n✅ ${project.name} [${taskId}] completed in ${result.turns} turns`))
          } else {
            console.log(chalk.yellow(`\n⚠️  ${project.name} [${taskId}] finished without committing (${result.turns} turns)`))
            console.log(chalk.gray('   Check the output above - changes may need manual review'))
          }
        } catch (err) {
          recordMetric({
            timestamp: new Date().toISOString(),
            repo: project.name,
            taskId,
            taskTitle: task.title,
            backend,
            durationMs: Date.now() - seqStart,
            turns: 0,
            success: false,
            committed: false,
          })
          console.error(chalk.red(`\n❌ Agent failed on ${project.name}: ${String(err)}`))
        }
      }

      // Commit handoff state after each round
      commitHandoffState(seqTargets.map(p => p.repoPath), `aahp-runner sequential round ${seqRound}`)

      // Without --follow-up, run each target once and stop
      if (!opts.followUp) break
    }
  })

// ── config ────────────────────────────────────────────────────────────────────

program
  .command('config')
  .description('Set persistent configuration (stored in ~/.aahp-runner.json)')
  .option('-r, --root <path>', 'Set root development folder')
  .option('-k, --api-key <key>', 'Set Anthropic API key')
  .option('-b, --backend <backend>', 'Set default backend: auto, claude, copilot, sdk')
  .option('--timeout <minutes>', 'Set default per-agent timeout in minutes')
  .option('--alert-webhook <url>', 'Set webhook URL for alerts (HTTP POST)')
  .option('--alert-slack <url>', 'Set Slack incoming webhook URL for alerts')
  .option('--alert-clear', 'Remove all alert settings')
  .action((opts: { root?: string; apiKey?: string; backend?: string; timeout?: string; alertWebhook?: string; alertSlack?: string; alertClear?: boolean }) => {
    let changed = false
    if (opts.root) {
      saveConfig({ rootDir: opts.root })
      console.log(chalk.green(`✅ Root set to: ${opts.root}`))
      changed = true
    }
    if (opts.apiKey) {
      saveConfig({ apiKey: opts.apiKey })
      console.log(chalk.green('✅ API key saved to ~/.aahp-runner.json'))
      changed = true
    }
    if (opts.backend) {
      const valid = ['auto', 'claude', 'copilot', 'sdk']
      if (!valid.includes(opts.backend)) {
        console.error(chalk.red(`Invalid backend "${opts.backend}". Choose: ${valid.join(', ')}`))
        process.exit(1)
      }
      saveConfig({ backend: opts.backend as 'auto' | 'claude' | 'copilot' | 'sdk' })
      console.log(chalk.green(`✅ Default backend set to: ${opts.backend}`))
      changed = true
    }
    if (opts.timeout) {
      const minutes = parseInt(opts.timeout, 10)
      if (isNaN(minutes) || minutes < 1) {
        console.error(chalk.red('Timeout must be a positive number of minutes'))
        process.exit(1)
      }
      saveConfig({ timeoutMinutes: minutes })
      console.log(chalk.green(`✅ Default timeout set to: ${minutes} minutes`))
      changed = true
    }
    if (opts.alertWebhook) {
      const existing = loadConfig()
      saveConfig({ alerts: { ...existing.alerts, webhook: opts.alertWebhook } })
      console.log(chalk.green(`✅ Alert webhook set`))
      changed = true
    }
    if (opts.alertSlack) {
      const existing = loadConfig()
      saveConfig({ alerts: { ...existing.alerts, slack: opts.alertSlack } })
      console.log(chalk.green(`✅ Slack alert webhook set`))
      changed = true
    }
    if (opts.alertClear) {
      saveConfig({ alerts: undefined })
      console.log(chalk.green('✅ Alert settings cleared'))
      changed = true
    }
    if (!changed) {
      const cfg = loadConfig()
      console.log(chalk.bold('\nCurrent config (~/.aahp-runner.json):'))
      console.log(`  root:      ${cfg.rootDir ?? '(not set - use AAHP_ROOT env or --root)'}`)
      console.log(`  apiKey:    ${cfg.apiKey ? '***set***' : '(not set - use ANTHROPIC_API_KEY env)'}`)
      console.log(`  backend:   ${cfg.backend ?? 'auto'}`)
      console.log(`  timeout:   ${cfg.timeoutMinutes ? cfg.timeoutMinutes + 'm' : '10m (default)'}`)
      console.log(`  schedule:  ${cfg.scheduledTime ?? '(not scheduled)'}`)
      console.log(`  alerts:`)
      if (cfg.alerts?.webhook) console.log(`    webhook: ${cfg.alerts.webhook}`)
      else console.log(chalk.gray(`    webhook: (not set)`))
      if (cfg.alerts?.slack) console.log(`    slack:   ${cfg.alerts.slack}`)
      else console.log(chalk.gray(`    slack:   (not set)`))
    }
  })

// ── schedule ──────────────────────────────────────────────────────────────────

program
  .command('schedule')
  .description('Register a daily scheduled job (cron on Linux/macOS, Task Scheduler on Windows)')
  .option('--time <HH:MM>', 'Time to run daily', '02:00')
  .option('-r, --root <path>', 'Root development folder')
  .option('--remove', 'Remove the scheduled job instead of creating one')
  .action((opts: { time: string; root?: string; remove?: boolean }) => {
    if (opts.remove) {
      unregisterScheduler()
      return
    }
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    saveConfig({ scheduledTime: opts.time, rootDir })
    registerScheduler(opts.time, rootDir)
  })

// ── logs — tail an agent's log file ──────────────────────────────────────────

program
  .command('logs [repo]')
  .description('Show or tail the latest log for an agent. Omit repo to list all logs.')
  .option('-f, --follow', 'Stream log in real-time (like tail -f)')
  .option('-n, --lines <n>', 'Show last N lines', '40')
  .option('-r, --root <path>', 'Root development folder (for per-repo .ai/logs/ scan)', DEFAULT_ROOT)
  .action(async (repo: string | undefined, opts: { follow: boolean; lines: string; root: string }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT

    // Collect log files from both per-repo .ai/logs/ and global ~/.aahp/logs/
    interface LogEntry { name: string; logPath: string; mtime: number; size: number }
    const allLogs: LogEntry[] = []

    // Per-repo: scan rootDir for repos with .ai/logs/
    try {
      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const repoLogDir = path.join(rootDir, entry.name, '.ai', 'logs')
        if (!fs.existsSync(repoLogDir)) continue
        for (const f of fs.readdirSync(repoLogDir).filter(f => f.endsWith('.log'))) {
          const logPath = path.join(repoLogDir, f)
          const stat = fs.statSync(logPath)
          allLogs.push({ name: entry.name, logPath, mtime: stat.mtimeMs, size: stat.size })
        }
      }
    } catch { /* ignore */ }

    // Global fallback: ~/.aahp/logs/
    fs.mkdirSync(LOG_DIR, { recursive: true })
    for (const f of fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'))) {
      const logPath = path.join(LOG_DIR, f)
      const stat = fs.statSync(logPath)
      const name = f.replace(/-\d{4}-\d{2}-\d{2}\.log$/, '').replace(/-plan\.log$/, '').replace(/\.log$/, '')
      allLogs.push({ name, logPath, mtime: stat.mtimeMs, size: stat.size })
    }

    // Sort newest first
    allLogs.sort((a, b) => b.mtime - a.mtime)

    if (!repo) {
      if (allLogs.length === 0) {
        console.log(chalk.gray('No logs yet. Logs are written when agents run via: aahp run --all --yes'))
        return
      }
      console.log(chalk.bold(`\n📋 Agent logs\n`))
      for (const l of allLogs) {
        const size = (l.size / 1024).toFixed(1)
        const rel = l.logPath.startsWith(rootDir)
          ? path.relative(rootDir, l.logPath)
          : l.logPath
        console.log(`  ${chalk.cyan(l.name.padEnd(32))} ${chalk.gray(`${rel}  ${size} KB`)}`)
      }
      console.log(chalk.gray(`\n  aahp logs <repo>        show last 40 lines`))
      console.log(chalk.gray(`  aahp logs <repo> -f     stream live`))
      return
    }

    // Find the latest log for this repo (check .ai/logs/ first, then global fallback)
    const matches = allLogs
      .filter(l => l.name === repo || l.name.includes(repo))
      .sort((a, b) => b.mtime - a.mtime)

    if (matches.length === 0) {
      console.log(chalk.yellow(`No log found for "${repo}"`))
      const names = [...new Set(allLogs.map(l => l.name))]
      console.log(chalk.gray(`Available: ${names.join(', ')}`))
      return
    }

    const logPath = matches[0]!.logPath
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
      const liveMap = new Map(live.map(s => [s.repoName ?? path.basename(s.repoPath), s]))

      const now = new Date()
      const clock = now.toLocaleTimeString('en-GB', { hour12: false })
      const liveCount = live.length

      const ICON: Record<string, string> = {
        live: chalk.cyan('🔄'), ready: chalk.gray('⏳'), done: chalk.green('✅'), blocked: chalk.red('🚫'),
      }

      // Column widths - match aahp list style
      const termWidth = process.stdout.columns || 100
      const W_NAME  = Math.min(26, Math.max(12, ...projects.map(p => p.name.length)))
      const W_PHASE = Math.min(14, Math.max(5,  ...projects.map(p => (p.manifest.last_session.phase ?? '').length)))
      const W_CNT   = 5
      // Icon col fixed at 4 visible (space + emoji(2) + space), borders add 13 more
      const W_ACT   = Math.max(20, termWidth - W_NAME - W_PHASE - W_CNT - 4 - 13)

      const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s
      const cell  = (s: string, w: number) => trunc(s, w).padEnd(w)

      const divider = (l: string, m: string, r: string) =>
        chalk.gray(
          l + '─'.repeat(4) +
          m + '─'.repeat(W_NAME + 2) +
          m + '─'.repeat(W_PHASE + 2) +
          m + '─'.repeat(W_CNT + 2) +
          m + '─'.repeat(W_ACT + 2) + r
        )

      const titleLine = [
        chalk.bold('📋 AAHP Status'),
        chalk.gray(clock),
        liveCount > 0 ? chalk.cyan(`${liveCount} live`) : '',
        chalk.gray(`${projects.length} projects`),
      ].filter(Boolean).join(chalk.gray(' · '))

      console.log('\n' + titleLine)
      console.log(divider('┌', '┬', '┐'))
      console.log(
        chalk.gray('│ ') + '  ' + chalk.gray(' │ ') +
        chalk.bold(cell('Project', W_NAME)) + chalk.gray(' │ ') +
        chalk.bold(cell('Phase', W_PHASE)) + chalk.gray(' │ ') +
        chalk.bold(cell('Tasks', W_CNT)) + chalk.gray(' │ ') +
        chalk.bold(cell('Activity', W_ACT)) + chalk.gray(' │')
      )
      console.log(divider('├', '┼', '┤'))

      for (const p of projects) {
        const liveSession = liveMap.get(p.name)
        const isLive = !!liveSession
        const top = getTopTask(p)
        const taskCount = p.readyTasks.length + p.activeTasks.length + p.blockedTasks.length + p.cancelledTasks.length
        const phase = p.manifest.last_session.phase ?? ''

        const icon = isLive ? ICON['live']! :
          taskCount > 0 ? ICON['ready']! :
          ICON['done']!

        // Activity column: for live show elapsed + task + last log; for ready show top task
        let actText = ''
        if (isLive && liveSession) {
          const elapsedMs = liveSession.startedAt
            ? now.getTime() - new Date(liveSession.startedAt).getTime() : 0
          const sec = Math.floor(elapsedMs / 1000)
          const elapsedStr = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`
          const logLine = getLastLogLine(p.name)
          actText = [elapsedStr, liveSession.taskId ? `[${liveSession.taskId}]` : '', logLine]
            .filter(Boolean).join(' · ')
        } else if (top) {
          const [id, task] = top
          const gh = task.github_issue ? ` #${task.github_issue}` : ''
          actText = `${id} ${task.title}${gh}`
        } else {
          actText = 'all done'
        }

        const nameCell  = cell(p.name, W_NAME)
        const phaseCell = cell(phase, W_PHASE)
        const cntCell   = cell(taskCount > 0 ? String(taskCount) : '-', W_CNT)
        const actCell   = cell(actText, W_ACT)

        const nameColored  = isLive ? chalk.white.bold(nameCell) : chalk.white(nameCell)
        const phaseColored = chalk.cyan(phaseCell)
        const cntColored   = taskCount > 0 ? chalk.yellow(cntCell) : chalk.gray(cntCell)
        const actColored   = isLive ? chalk.gray(actCell) :
          taskCount > 0 ? chalk.white(actCell) : chalk.gray(actCell)

        console.log(
          chalk.gray('│ ') + icon + chalk.gray(' │ ') + nameColored +
          chalk.gray(' │ ') + phaseColored +
          chalk.gray(' │ ') + cntColored +
          chalk.gray(' │ ') + actColored +
          chalk.gray(' │')
        )
      }

      console.log(divider('└', '┴', '┘'))
      const actionableCount = projects.filter(p => p.readyTasks.length + p.activeTasks.length + p.blockedTasks.length + p.cancelledTasks.length > 0 || liveMap.has(p.name)).length
      console.log(chalk.gray(`\n  ${projects.length} projects scanned · `) + chalk.yellow(String(actionableCount)) + chalk.gray(' with tasks'))
      if (liveCount > 0) {
        console.log(chalk.gray('  aahp logs <repo>      for agent output'))
      } else if (actionableCount > 0) {
        console.log(chalk.gray('  aahp run --all --yes  to start agents'))
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

// ── metrics ──────────────────────────────────────────────────────────────────

program
  .command('metrics')
  .description('Show historical run metrics and trends')
  .option('--json', 'Output raw JSON instead of formatted table')
  .option('--repo <name>', 'Filter by repository name')
  .option('--days <n>', 'Show last N days (default: 30)', '30')
  .action((opts: { json: boolean; repo?: string; days: string }) => {
    const days = parseInt(opts.days, 10) || 30
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const metrics = loadMetrics({ repo: opts.repo, since })

    if (metrics.length === 0) {
      console.log(chalk.gray('\nNo metrics recorded yet.'))
      console.log(chalk.gray('Metrics are saved automatically after each agent run.'))
      console.log(chalk.gray(`File: ${metricsFilePath()}`))
      return
    }

    if (opts.json) {
      const summary = summarizeMetrics(metrics)
      console.log(JSON.stringify({ metrics, summary }, null, 2))
      return
    }

    const summary = summarizeMetrics(metrics)

    console.log(chalk.bold(`\n📊 AAHP Metrics (last ${days} days)\n`))
    console.log(`  Total runs:    ${chalk.bold(String(summary.totalRuns))}`)
    const rateColor = summary.successRate >= 80 ? chalk.green : summary.successRate >= 50 ? chalk.yellow : chalk.red
    console.log(`  Success rate:  ${rateColor(summary.successRate + '%')}`)
    console.log(`  Avg duration:  ${chalk.cyan(formatDuration(summary.avgDurationMs))}`)
    console.log()

    // Per-repo table
    const repos = Object.entries(summary.byRepo).sort(([, a], [, b]) => b.runs - a.runs)
    if (repos.length > 0) {
      console.log(chalk.bold('  By repository:'))
      console.log(chalk.gray(`  ${'Repo'.padEnd(28)} ${'Runs'.padStart(5)} ${'OK'.padStart(4)} ${'Rate'.padStart(6)} ${'Avg'.padStart(8)}`))
      console.log(chalk.gray('  ' + '-'.repeat(55)))
      for (const [repo, stats] of repos) {
        const rate = stats.runs > 0 ? Math.round((stats.successes / stats.runs) * 100) : 0
        console.log(`  ${repo.padEnd(28)} ${String(stats.runs).padStart(5)} ${String(stats.successes).padStart(4)} ${(rate + '%').padStart(6)} ${formatDuration(stats.avgMs).padStart(8)}`)
      }
      console.log()
    }

    // Per-backend table
    const backends = Object.entries(summary.byBackend)
    if (backends.length > 0) {
      console.log(chalk.bold('  By backend:'))
      for (const [backend, stats] of backends) {
        const rate = stats.runs > 0 ? Math.round((stats.successes / stats.runs) * 100) : 0
        console.log(`  ${chalk.cyan(backend.padEnd(20))} ${stats.runs} runs, ${rate}% success`)
      }
      console.log()
    }

    // Daily trend (last 7 days)
    const recentDays = summary.daily.slice(-7)
    if (recentDays.length > 0) {
      console.log(chalk.bold('  Daily trend:'))
      for (const day of recentDays) {
        const bar = chalk.green('#'.repeat(Math.min(day.successes, 30))) + chalk.red('#'.repeat(Math.min(day.runs - day.successes, 30)))
        console.log(`  ${chalk.gray(day.date)} ${bar} ${day.successes}/${day.runs}`)
      }
      console.log()
    }

    console.log(chalk.gray(`  Data: ${metricsFilePath()}`))
    console.log(chalk.gray('  Export: aahp metrics --json > metrics.json'))
    console.log()
  })

// ── plan ──────────────────────────────────────────────────────────────────────
program
  .command('plan [project]')
  .description('Run a planning agent on idle repos to generate new NEXT_ACTIONS.md tasks')
  .option('-r, --root <path>', 'Root development folder', DEFAULT_ROOT)
  .option('-a, --all', 'Plan ALL idle repos, not just the first one')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--local', 'Include local-only repos (no GitHub remote)')
  .option('--backend <backend>', 'Agent backend: auto | claude | copilot | sdk', 'auto')
  .option('--timeout <minutes>', 'Planning timeout per repo in minutes', '5')
  .action(async (project: string | undefined, opts: { root: string; all: boolean; yes: boolean; local: boolean; backend: string; timeout: string }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const backend = (opts.backend ?? config.backend ?? 'auto') as 'auto' | 'claude' | 'copilot' | 'sdk'
    const timeoutMin = parseInt(opts.timeout, 10) || 5

    const projects = scanProjects(rootDir)

    // Filter target projects
    let targets = project
      ? projects.filter(p => p.name === project || p.repoPath.endsWith(project))
      : projects.filter(p => p.readyTasks.length === 0 && p.activeTasks.length === 0)

    // Handle local repos
    const localRepos = targets.filter(p => p.isLocalOnly)
    const ghRepos    = targets.filter(p => !p.isLocalOnly)

    if (localRepos.length > 0 && !opts.local && !opts.yes) {
      console.log(chalk.yellow(`\n⚠  ${localRepos.length} local-only repo(s) found (no GitHub remote):`))
      for (const p of localRepos) console.log(chalk.gray(`   ${p.name}`))
      const include = await promptYN('\nInclude local repos in planning? [y/N] ')
      if (!include) targets = ghRepos
    } else if (!opts.local) {
      targets = ghRepos  // default: skip local repos unless --local
    }

    if (!opts.all && !project) targets = targets.slice(0, 1)

    if (targets.length === 0) {
      console.log(chalk.green('\n✅ No idle repos to plan for - all projects have ready tasks'))
      return
    }

    console.log(chalk.bold(`\n📐 AAHP Planning — ${targets.length} repo(s)\n`))
    for (const p of targets) {
      console.log(chalk.gray(`  ${p.name} (${p.repoPath})`))
    }

    if (!opts.yes) {
      const ok = await promptYN(`\nRun planning agent on ${targets.length} repo(s)? [y/N] `)
      if (!ok) { console.log(chalk.gray('Cancelled.')); return }
    }

    const apiKey = config.apiKey ?? ''
    let planned = 0

    for (const p of targets) {
      console.log(chalk.bold(`\n─── Planning: ${p.name} ───`))
      try {
        const result = await runPlanningAgent(p, apiKey, (msg) => process.stdout.write(msg), backend, timeoutMin)
        if (result.success) {
          // Re-scan to pick up new tasks from NEXT_ACTIONS.md → MANIFEST → GitHub issues
          const updated = scanProjectByPath(p.repoPath)
          const newTasks = (updated?.readyTasks.length ?? 0)
          console.log(chalk.green(`\n✅ ${p.name}: planning done — ${newTasks} ready task(s) created`))
          planned++
        } else {
          console.log(chalk.yellow(`\n⚠  ${p.name}: planning produced no output`))
        }
      } catch (err) {
        console.log(chalk.red(`\n❌ ${p.name}: planning failed — ${(err as Error).message}`))
      }
    }

    console.log(chalk.bold(`\n📐 Planning complete: ${planned}/${targets.length} repos updated`))
    console.log(chalk.gray('  Run: aahp run --all --yes   to execute the new tasks'))
    console.log()
  })

// ── overnight ─────────────────────────────────────────────────────────────────
program
  .command('overnight')
  .description('Full autonomous loop: plan idle repos, run all agents, commit+push. Repeats until --hours expires.')
  .option('-r, --root <path>', 'Root development folder', DEFAULT_ROOT)
  .option('-y, --yes', 'Skip all confirmation prompts')
  .option('--hours <n>', 'Stop after N hours (0 = run forever)', '8')
  .option('--limit <n>', 'Max concurrent agents per cycle', '5')
  .option('--pause <n>', 'Minutes to pause between cycles (default: 0)', '0')
  .option('--local', 'Include local-only repos (no GitHub remote)')
  .option('--backend <backend>', 'Agent backend: auto | claude | copilot | sdk', 'auto')
  .option('--plan-timeout <minutes>', 'Planning timeout per repo in minutes', '5')
  .option('--run-timeout <minutes>', 'Per-agent execution timeout in minutes', '10')
  .action(async (opts: {
    root: string; yes: boolean; hours: string; limit: string; pause: string;
    local: boolean; backend: string; planTimeout: string; runTimeout: string
  }) => {
    const config   = loadConfig()
    const rootDir  = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const backend  = (opts.backend ?? config.backend ?? 'auto') as 'auto' | 'claude' | 'copilot' | 'sdk'
    const hours    = parseFloat(opts.hours) || 8
    const maxLimit = parseInt(opts.limit, 10) || 5
    const pauseMin = parseInt(opts.pause, 10) || 0
    const planTout = parseInt(opts.planTimeout, 10) || 5
    const runTout  = parseInt(opts.runTimeout, 10) || (config.timeoutMinutes ?? 10)
    const apiKey   = config.apiKey ?? ''

    const stopAt = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null
    const logDir = path.join(rootDir, '.ai', 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const logFile = path.join(logDir, `overnight-${new Date().toISOString().slice(0, 10)}.log`)

    const log = (msg: string) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`
      console.log(line)
      fs.appendFileSync(logFile, line + '\n', 'utf8')
    }

    // Decide on local repos once at start
    let includeLocal = opts.local
    if (!includeLocal && !opts.yes) {
      const allRepos = scanAllGitRepos(rootDir)
      const localCount = allRepos.filter(r => !r.isGitHub && r.hasManifest).length
      if (localCount > 0) {
        const names = allRepos.filter(r => !r.isGitHub && r.hasManifest).map(r => r.name)
        console.log(chalk.yellow(`\n⚠  ${localCount} local-only repo(s) found: ${names.join(', ')}`))
        includeLocal = await promptYN('Include local repos in overnight run? [y/N] ')
      }
    }

    log('════════════════════════════════════════════════')
    log('  AAHP Overnight — autonomous loop starting')
    log(`  Stop at  : ${stopAt ? stopAt.toLocaleTimeString() : 'never (Ctrl+C to stop)'}`)
    log(`  Limit    : ${maxLimit} agents/cycle`)
    log(`  Pause    : ${pauseMin > 0 ? pauseMin + 'min between cycles' : 'none — continuous loop'}`)
    log(`  Backend  : ${backend}`)
    log(`  Root     : ${rootDir}`)
    log(`  Log      : ${logFile}`)
    log('════════════════════════════════════════════════')

    let cycle = 0
    let totalPlanned = 0
    let totalRuns = 0
    let totalCommits = 0

    // Helper: commit+push all dirty repos
    const commitAll = async (): Promise<number> => {
      const { execSync: exec } = await import('child_process')
      let n = 0
      const entries = fs.readdirSync(rootDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const d = path.join(rootDir, entry.name)
        if (!fs.existsSync(path.join(d, '.git'))) continue
        try {
          const dirty = exec('git status --porcelain', { cwd: d, stdio: 'pipe' }).toString().trim()
          if (!dirty) continue
          exec('git add -A', { cwd: d, stdio: 'pipe' })
          exec(`git commit -m "chore: overnight agent run ${new Date().toISOString().slice(0, 16)}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"`, { cwd: d, stdio: 'pipe' })
          try { exec('git push', { cwd: d, stdio: 'pipe' }) } catch { /* push failure is non-fatal */ }
          log(`  ✅ ${entry.name} committed + pushed`)
          n++
        } catch { /* repo may have nothing to commit */ }
      }
      return n
    }

    while (!stopAt || new Date() < stopAt) {
      cycle++
      const remaining = stopAt
        ? ` (${Math.round((stopAt.getTime() - Date.now()) / 60000)}min left)`
        : ''
      log('')
      log(`━━━ CYCLE ${cycle}${remaining} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

      // ── Phase 1: plan idle repos ───────────────────────────────────────────
      const projects = scanProjects(rootDir)
      const idle = projects.filter(p => {
        if (!includeLocal && p.isLocalOnly) return false
        return p.readyTasks.length === 0 && p.activeTasks.length === 0
      })

      if (idle.length > 0) {
        log(`  📐 Planning ${idle.length} idle repo(s)...`)
        for (const p of idle) {
          try {
            log(`     Planning: ${p.name}`)
            const result = await runPlanningAgent(p, apiKey, (msg) => fs.appendFileSync(logFile, msg, 'utf8'), backend, planTout)
            if (result.success) {
              scanProjectByPath(p.repoPath)  // sync new tasks → MANIFEST → GH issues
              log(`     ✅ ${p.name}: planned`)
              totalPlanned++
            }
          } catch (err) {
            log(`     ❌ ${p.name}: planning failed — ${(err as Error).message}`)
          }
        }
      }

      // ── Phase 2: run agents on actionable tasks ────────────────────────────
      const fresh = scanProjects(rootDir).filter(p => {
        if (!includeLocal && p.isLocalOnly) return false
        return p.readyTasks.length > 0 || p.activeTasks.length > 0
      })

      if (fresh.length > 0) {
        log(`  🤖 Running agents on ${fresh.length} repo(s) (limit ${maxLimit})...`)

        const runTasks = fresh.flatMap(p => {
          const top = getTopTask(p)
          return top ? [{ project: p, taskId: top[0], task: top[1] }] : []
        })

        const statuses: AgentStatus[] = runTasks.map(({ project: p, taskId, task }) => ({
          repo: p.name, taskId, taskTitle: task.title,
          state: 'queued' as const, lastLine: '', logFile: agentLogPath(p.name, p.repoPath), committed: false,
        }))
        const board = new StatusBoard(statuses)
        board.start()
        const ticker = setInterval(() => board.refresh(), 1000)

        await runWithLimit(runTasks, maxLimit, async ({ project: p, taskId, task }) => {
          const st = statuses.find(s => s.repo === p.name)!
          st.state = 'running'
          st.startedAt = new Date()
          board.refresh()
          try {
            const result = await runAgent(p, taskId, task, apiKey, msg => {
              const line = msg.replace(/\x1B\[[0-9;]*m/g, '').split('\n').reverse().find(l => l.trim())
              if (line) st.lastLine = line.trim()
              board.refresh()
            }, backend, runTout)
            st.state = result.committed ? 'done' : 'failed'
            st.committed = result.committed
            st.finishedAt = new Date()
            st.lastLine = result.committed ? 'committed' : 'no commit detected'
            board.refresh()
            log(`     ${result.committed ? '✅' : '⚠ '} ${p.name} [${taskId}]: ${result.committed ? 'committed' : 'no commit'}`)
            totalRuns++
            await recordMetric({
              timestamp: new Date().toISOString(), repo: p.name, taskId, taskTitle: task.title,
              backend, durationMs: (st.finishedAt?.getTime() ?? Date.now()) - (st.startedAt?.getTime() ?? Date.now()),
              turns: result.turns, success: result.committed, committed: result.committed,
            })
          } catch (err) {
            st.state = 'failed'
            st.finishedAt = new Date()
            st.lastLine = String(err).slice(0, 60)
            board.refresh()
            log(`     ❌ ${p.name} [${taskId}]: ${(err as Error).message}`)
          }
        })

        clearInterval(ticker)
        board.finish()
      } else {
        log('  💤 No actionable tasks — all repos idle or planning failed')
      }

      // ── Phase 3: commit + push ─────────────────────────────────────────────
      log('  💾 Committing all changes...')
      const n = await commitAll()
      totalCommits += n
      log(`  ${n} repo(s) committed  |  total: ${totalCommits}`)

      // ── Check time limit ───────────────────────────────────────────────────
      if (stopAt && new Date() >= stopAt) break

      // ── Optional pause ─────────────────────────────────────────────────────
      if (pauseMin > 0) {
        const until = Date.now() + pauseMin * 60 * 1000
        log(`  ⏸  Pausing ${pauseMin}min before next cycle...`)
        while (Date.now() < until) await new Promise(r => setTimeout(r, 30_000))
      }
    }

    log('')
    log('════════════════════════════════════════════════')
    log('  AAHP Overnight — FINISHED')
    log(`  Cycles : ${cycle}`)
    log(`  Planned: ${totalPlanned} repos`)
    log(`  Runs   : ${totalRuns} agents`)
    log(`  Commits: ${totalCommits} repos`)
    log(`  Log    : ${logFile}`)
    log('════════════════════════════════════════════════')
    console.log()
  })

program
  .name('aahp')
  .description('Autonomous AAHP agent runner - spawns Claude/Copilot agents to plan tasks, implement them, and commit')
  .version('0.1.0')
  .addHelpText('after', `
Backends:
  auto     Prefers Claude Code CLI, falls back to GitHub Copilot, then Anthropic SDK
  claude   Claude Code CLI only (requires VS Code Claude Code extension)
  copilot  GitHub Copilot only (requires: gh auth login with Copilot subscription)
  sdk      Anthropic API key only

Autonomy modes:
  Single pass      aahp run --all --yes                   run current tasks, stop
  Self-chaining    aahp run --all --yes --follow-up        run → plan idle → re-run, until done
  Overnight loop   aahp overnight --yes                    plan+run+commit cycle, 8h by default
  Forever daemon   aahp overnight --yes --hours 0          same, never stops (Ctrl+C)
  Scheduled        aahp schedule --time 02:00              OS-level daily trigger

Examples:
  aahp                               Guided setup wizard
  aahp list                          Repos with actionable tasks
  aahp list --all                    Include idle repos (no tasks)
  aahp status                        Snapshot of live agents + project table
  aahp status -w                     Auto-refresh every 3s (Ctrl+C to stop)

  aahp run openclaw-ops              Run agent on one project (interactive confirm)
  aahp run --all --yes               Spawn agents on ALL projects in parallel
  aahp run --all --yes --backend claude     Use Claude Code for all tasks
  aahp run --all --yes --backend copilot    Use GitHub Copilot for all tasks
  aahp run --all --yes --limit 3     Cap at 3 concurrent agents
  aahp run --all --yes --timeout 15  Set per-agent timeout to 15 minutes
  aahp run --all --yes --follow-up   Run, then plan idle repos, re-run new tasks (chains)

  aahp plan                          Plan first idle repo (asks confirm)
  aahp plan --all --yes              Plan ALL idle repos without prompts
  aahp plan openclaw-ops             Plan a specific repo
  aahp plan --local                  Include repos with no GitHub remote

  aahp overnight --yes               Full autonomous loop: plan+run+commit, 8h
  aahp overnight --yes --hours 0     Run forever until Ctrl+C
  aahp overnight --yes --limit 3 --pause 10   3 agents, 10min between cycles
  aahp overnight --yes --local       Include local-only repos (no GitHub remote)

  aahp logs                          List all agent logs (per-repo .ai/logs/ + fallback)
  aahp logs openclaw-ops             Show last 40 lines of agent log
  aahp logs openclaw-ops -f          Stream agent log live (tail -f)
  aahp logs openclaw-ops -n 100      Show last 100 lines

  aahp metrics                       Show historical run metrics
  aahp metrics --json                Export metrics as JSON
  aahp metrics --repo openclaw-ops --days 7

  aahp config --root "E:\\_Development"     Set root folder
  aahp config --backend copilot              Save default backend
  aahp config --api-key sk-ant-...           Save Anthropic API key
  aahp config --timeout 15                   Set default timeout (minutes)
  aahp config --alert-webhook <url>          Set webhook for alerts
  aahp config --alert-slack <url>            Set Slack webhook for alerts

  aahp schedule --time 02:00         Register nightly cron/Task Scheduler job
  aahp schedule --remove             Remove the scheduled job

Log locations:
  repoPath/.ai/logs/YYYY-MM-DD.log          per-repo agent run log (auto-gitignored)
  rootDir/.ai/logs/overnight-YYYY-MM-DD.log overnight loop log
  ~/.aahp/logs/                             fallback (legacy) log location
  ~/.aahp/metrics.jsonl                     run metrics (all repos, all time)
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
    console.log(chalk.white('  Run:') + chalk.cyan(`  aahp config --root "E:\\_Development"`))
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
    const issueTag = task.github_issue ? chalk.cyan(` [GH#${task.github_issue}]`) : ''
    console.log(`  ${chalk.bold(p.name.padEnd(28))} ${priorityColor(`[${id}]`)} ${task.title}${issueTag}`)
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
  console.log(chalk.gray('  Schedule nightly runs (cron on Linux/macOS, Task Scheduler on Windows):'))
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return remSec > 0 ? `${min}m${remSec}s` : `${min}m`
}
