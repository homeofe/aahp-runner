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

/** Strip ANSI escape sequences so we can measure visible text width */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
}

/** Count visible terminal columns. Emoji and common wide chars count as 2. */
function visibleWidth(s: string): number {
  const plain = stripAnsi(s)
  let w = 0
  for (const ch of [...plain]) {
    const cp = ch.codePointAt(0) ?? 0
    // Misc Technical (⏳), Misc Symbols + Dingbats (✅ ❌), extended emoji (🔄 🤖)
    const wide = (cp >= 0x2300 && cp <= 0x23FF) ||
                 (cp >= 0x2600 && cp <= 0x27FF) ||
                 (cp >= 0x1F000)
    w += wide ? 2 : 1
  }
  return w
}

/** Count actual terminal rows consumed by these lines after joining with \n.
 *  Each line occupies ceil(visibleWidth / termCols) rows, min 1 (for the \n). */
function termRowCount(lines: string[], termCols: number): number {
  // The trailing '' in lines produces a final \n but no extra row for itself
  return lines.slice(0, -1).reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(visibleWidth(line) / termCols))
  }, 0)
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
    // Move cursor up and erase everything below - \x1B[J clears any stale content
    // even if cursor position is slightly off (e.g. from previous wrapping)
    process.stdout.write(`\x1B[${this._headerLines}A\x1B[J`)
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
      const name    = (s.state === 'running' ? chalk.white : chalk.gray)(s.repo.padEnd(26))
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
        ? chalk.gray(' · ' + s.lastLine.replace(/\s+/g, ' ').slice(0, 24))
        : ''
      lines.push(`  ${icon} ${name} ${task} ${time}${resources}${eta}${hint}`)
    }

    lines.push(chalk.gray('─'.repeat(hasResources ? 80 : 60)))
    lines.push(chalk.gray(`Logs: tail -f ~/.aahp/logs/<repo>.log  |  aahp logs <repo>`))
    lines.push('')  // blank trailing line

    this._headerLines = termRowCount(lines, process.stdout.columns || 80)
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
