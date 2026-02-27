import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import chalk from 'chalk'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentState = 'queued' | 'running' | 'done' | 'failed'

export interface AgentStatus {
  repo: string
  taskId: string
  taskTitle: string
  state: AgentState
  startedAt?: Date
  finishedAt?: Date
  lastLine: string       // last non-empty log line (shown in status)
  logFile: string        // absolute path to log file
  committed: boolean
  cpuPercent?: number    // latest CPU % from resource monitor
  memMB?: number         // latest memory in MB from resource monitor
  estimatedEndAt?: Date  // ETA based on historical data
  currentTurn?: number   // current turn (SDK/Copilot only)
  maxTurns?: number      // max turns (SDK/Copilot only)
}

// ── Log directory ─────────────────────────────────────────────────────────────

export const LOG_DIR = path.join(os.homedir(), '.aahp', 'logs')

export function agentLogPath(repo: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  fs.mkdirSync(LOG_DIR, { recursive: true })
  return path.join(LOG_DIR, `${repo}-${stamp}.log`)
}

/** Write a line to the agent's log file (silent on error) */
export function writeLog(logFile: string, text: string): void {
  try { fs.appendFileSync(logFile, text) } catch { /* best-effort */ }
}

// ── Status board ──────────────────────────────────────────────────────────────

const STATUS_ICON: Record<AgentState, string> = {
  queued:  chalk.gray('⏳'),
  running: chalk.cyan('🔄'),
  done:    chalk.green('✅'),
  failed:  chalk.red('❌'),
}

function elapsed(s: AgentStatus): string {
  if (!s.startedAt) return chalk.gray('queued')
  const ms = (s.finishedAt ?? new Date()).getTime() - s.startedAt.getTime()
  const sec = Math.floor(ms / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`
}

export class StatusBoard {
  private readonly _agents: AgentStatus[]
  private _headerLines = 0   // lines printed for header (re-drawn each tick)
  private _drawn = false

  constructor(agents: AgentStatus[]) {
    this._agents = agents
  }

  /** Call once before agents start */
  start(): void {
    process.stdout.write('\n')
    this._draw()
  }

  /** Redraw the board in-place */
  refresh(): void {
    if (!this._drawn) { this.start(); return }
    // Move cursor up by number of lines we drew last time
    process.stdout.write(`\x1B[${this._headerLines}A`)
    this._draw()
  }

  private _draw(): void {
    const done    = this._agents.filter(a => a.state === 'done').length
    const failed  = this._agents.filter(a => a.state === 'failed').length
    const running = this._agents.filter(a => a.state === 'running').length
    const total   = this._agents.length

    const lines: string[] = []

    // Header summary line
    const parts = [
      chalk.bold(`🤖 AAHP`),
      chalk.green(`${done}/${total} done`),
      running > 0 ? chalk.cyan(`${running} running`) : '',
      failed  > 0 ? chalk.red(`${failed} failed`)    : '',
    ].filter(Boolean).join(chalk.gray(' · '))
    lines.push(parts)
    lines.push(chalk.gray('─'.repeat(60)))

    // One line per agent
    const hasResources = this._agents.some(a => a.cpuPercent !== undefined || a.memMB !== undefined)

    for (const s of this._agents) {
      const icon    = STATUS_ICON[s.state]
      const name    = (s.state === 'running' ? chalk.white : chalk.gray)(s.repo.padEnd(28))
      const task    = chalk.yellow(`[${s.taskId}]`)
      const time    = chalk.gray(elapsed(s).padStart(6))

      // Resource columns (only shown when data is available)
      let resources = ''
      if (hasResources) {
        const cpu = s.cpuPercent !== undefined ? chalk.magenta(`${Math.round(s.cpuPercent)}%`.padStart(5)) : '     '
        const mem = s.memMB !== undefined ? chalk.blue(`${s.memMB}MB`.padStart(7)) : '       '
        resources = ` ${cpu} ${mem}`
      }

      // ETA column
      let eta = ''
      if (s.state === 'running' && s.estimatedEndAt) {
        const remainMs = s.estimatedEndAt.getTime() - Date.now()
        if (remainMs > 0) {
          const remainSec = Math.floor(remainMs / 1000)
          eta = chalk.gray(` ~${remainSec < 60 ? remainSec + 's' : Math.ceil(remainSec / 60) + 'm'}`)
        }
      } else if (s.state === 'running' && s.currentTurn && s.maxTurns) {
        eta = chalk.gray(` t${s.currentTurn}/${s.maxTurns}`)
      }

      const hint    = s.lastLine
        ? chalk.gray(' · ' + s.lastLine.replace(/\s+/g, ' ').slice(0, 30))
        : ''
      lines.push(`  ${icon} ${name} ${task} ${time}${resources}${eta}${hint}`)
    }

    lines.push(chalk.gray('─'.repeat(hasResources ? 80 : 60)))
    lines.push(chalk.gray(`Logs: tail -f ~/.aahp/logs/<repo>.log  |  aahp logs <repo>`))
    lines.push('')  // blank trailing line

    this._headerLines = lines.length
    process.stdout.write(lines.join('\n'))
    this._drawn = true
  }

  /** Print final summary below the board */
  finish(): void {
    this.refresh()
    const done   = this._agents.filter(a => a.state === 'done').length
    const failed = this._agents.filter(a => a.state === 'failed').length
    process.stdout.write('\n')
    if (failed === 0) {
      console.log(chalk.green.bold(`\n✅ All ${done} agents committed successfully`))
    } else {
      console.log(chalk.yellow.bold(`\n📊 ${done} committed · ${failed} failed`))
      for (const s of this._agents.filter(a => a.state === 'failed')) {
        console.log(chalk.red(`   ❌ ${s.repo}: check ${s.logFile}`))
      }
    }
  }
}
