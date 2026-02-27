#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import * as path from 'path'
import os from 'os'
import * as readline from 'readline'
import { scanProjects, getTopTask } from './scanner.js'
import { runAgent } from './agent.js'
import { loadConfig, saveConfig, registerWindowsScheduler } from './scheduler.js'

const DEFAULT_ROOT = process.env['AAHP_ROOT'] ?? path.join(os.homedir(), 'Development')

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
  .option('-k, --api-key <key>', 'Anthropic API key (or set ANTHROPIC_API_KEY env)')
  .action(async (projectName: string | undefined, opts: {
    root: string; all: boolean; yes: boolean; apiKey?: string
  }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? config.apiKey ?? ''

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

    // When --all --yes: run all in parallel
    if (opts.all && opts.yes) {
      console.log(chalk.bold(`\n🚀 Spawning ${targets.length} agents in parallel...\n`))
      targets.forEach(p => {
        const top = getTopTask(p)
        if (top) console.log(chalk.gray(`  ⏳ ${p.name} → [${top[0]}] ${top[1].title}`))
      })
      console.log()

      const results = await Promise.all(
        targets.map(async project => {
          const topTask = getTopTask(project)
          if (!topTask) return
          const [taskId, task] = topTask
          try {
            const result = await runAgent(project, taskId, task, apiKey, msg => {
              // Prefix each log line with repo name for parallel clarity
              process.stdout.write(chalk.gray(`[${project.name}] `) + msg + '\n')
            })
            if (result.success) {
              console.log(chalk.green(`✅ ${project.name} [${taskId}] committed`))
            } else {
              console.log(chalk.yellow(`⚠️  ${project.name} [${taskId}] no commit detected`))
            }
            return result
          } catch (err) {
            console.error(chalk.red(`❌ ${project.name}: ${String(err)}`))
          }
        })
      )

      const done = results.filter(r => r?.success).length
      const failed = results.filter(r => r && !r.success).length
      console.log(chalk.bold(`\n📊 Done: ${done}/${targets.length} committed, ${failed} partial`))
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

      const spinner = ora(`Running agent on ${project.name}...`).start()
      spinner.stop()

      try {
        const result = await runAgent(project, taskId, task, apiKey, msg => console.log(chalk.gray(msg)))

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
  .action((opts: { root?: string; apiKey?: string }) => {
    if (opts.root) {
      saveConfig({ rootDir: opts.root })
      console.log(chalk.green(`✅ Root set to: ${opts.root}`))
    }
    if (opts.apiKey) {
      saveConfig({ apiKey: opts.apiKey })
      console.log(chalk.green('✅ API key saved to ~/.aahp-runner.json'))
    }
    if (!opts.root && !opts.apiKey) {
      const cfg = loadConfig()
      console.log(chalk.bold('\nCurrent config (~/.aahp-runner.json):'))
      console.log(`  root:      ${cfg.rootDir ?? '(not set - use AAHP_ROOT env or --root)'}`)
      console.log(`  apiKey:    ${cfg.apiKey ? '***set***' : '(not set - use ANTHROPIC_API_KEY env)'}`)
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

// ── status (quick overview, no agent) ────────────────────────────────────────

program
  .command('status')
  .description('Quick status overview across all AAHP projects')
  .option('-r, --root <path>', 'Root development folder', DEFAULT_ROOT)
  .action((opts: { root: string }) => {
    const config = loadConfig()
    const rootDir = opts.root ?? config.rootDir ?? DEFAULT_ROOT
    const projects = scanProjects(rootDir)

    console.log(chalk.bold(`\n🤖 AAHP Status - ${rootDir}\n`))
    for (const p of projects) {
      const top = getTopTask(p)
      const phase = chalk.cyan(p.manifest.last_session.phase)
      const taskLine = top ? chalk.yellow(`[${top[0]}] ${top[1].title}`) : chalk.gray('all done')
      console.log(`  ${chalk.bold(p.name.padEnd(30))} ${phase.padEnd(20)} ${taskLine}`)
    }
    console.log()
  })

program
  .name('aahp')
  .description('Autonomous AAHP agent runner - spawns Claude agents to work through project tasks')
  .version('0.1.0')
  .addHelpText('after', `
Examples:
  aahp                        Guided setup - shows next step automatically
  aahp list                   See all projects and their top ready task
  aahp status                 Quick status overview
  aahp run --all --yes        Spawn agents on ALL projects in parallel (no prompts)
  aahp run openclaw-ops       Spawn agent on one project
  aahp config --api-key sk-…  Save Anthropic API key
  aahp schedule --time 02:00  Register nightly Windows Task Scheduler job
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
    console.log(chalk.white('  Run:') + chalk.cyan(`  aahp config --root "E:\\example.com\\_Data\\_Development"`))
    console.log()
    return
  }
  console.log(chalk.green('✅ Root:') + chalk.gray(` ${rootDir}`))

  // ── Step 2: check claude CLI ─────────────────────────────────────────────────
  const { execSync } = await import('child_process')
  let claudeOk = false
  try { execSync('claude --version', { stdio: 'pipe' }); claudeOk = true } catch {}

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
