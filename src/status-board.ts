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

/**
 * Return the log file path for an agent run.
 * If repoPath is given, logs go into `repoPath/.ai/logs/YYYY-MM-DD.log`
 * and `.ai/logs/` is added to the repo's .gitignore on first use.
 * Falls back to `~/.aahp/logs/<repo>-YYYY-MM-DD.log` for workspace-level logs.
 */
export function agentLogPath(repo: string, repoPath?: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  if (repoPath) {
    const logDir = path.join(repoPath, '.ai', 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    ensureGitignore(repoPath, '.ai/logs/')
    return path.join(logDir, `${stamp}.log`)
  }
  fs.mkdirSync(LOG_DIR, { recursive: true })
  return path.join(LOG_DIR, `${repo}-${stamp}.log`)
}

/** Ensure a pattern is present in repoPath/.gitignore (silent on error). */
function ensureGitignore(repoPath: string, pattern: string): void {
  try {
    const giPath = path.join(repoPath, '.gitignore')
    const content = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : ''
    if (!content.split('\n').some(l => l.trim() === pattern)) {
      fs.appendFileSync(giPath, (content.endsWith('\n') || content === '' ? '' : '\n') + pattern + '\n', 'utf8')
    }
  } catch { /* best-effort */ }
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
  if (!s.startedAt) return 'queued'
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

    const termWidth = process.stdout.columns || 100

    // Column widths (all in visible terminal columns)
    // Layout: │ icon │ name │ task │ time │ hint │
    // Fixed overhead: 1+4+1 + (W+2+1)×4 + (W+2+1) + 1 = 18 chars of borders/padding
    const W_NAME = Math.min(28, Math.max(12, ...this._agents.map(a => a.repo.length)))
    const W_TASK = 6    // T-XXX
    const W_TIME = 7    // 99m59s
    const W_HINT = Math.max(16, termWidth - W_NAME - W_TASK - W_TIME - 18)

    const trunc = (s: string, n: number) =>
      s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n)

    const divider = (l: string, m: string, r: string) =>
      chalk.gray(
        l + '─'.repeat(4) +                   // icon cell: space + 2-wide emoji + space
        m + '─'.repeat(W_NAME + 2) +
        m + '─'.repeat(W_TASK + 2) +
        m + '─'.repeat(W_TIME + 2) +
        m + '─'.repeat(W_HINT + 2) + r
      )

    const lines: string[] = []

    // Header summary (with live clock)
    const now = new Date().toLocaleTimeString('en-GB', { hour12: false })
    const summary = [
      chalk.bold('🤖 AAHP'),
      chalk.green(`${done}/${total} done`),
      running > 0 ? chalk.cyan(`${running} running`) : '',
      failed  > 0 ? chalk.red(`${failed} failed`)    : '',
      chalk.gray(now),
    ].filter(Boolean).join(chalk.gray(' · '))
    lines.push(summary)
    lines.push(divider('┌', '┬', '┐'))

    for (const s of this._agents) {
      const icon = STATUS_ICON[s.state]   // 2-wide emoji

      // Hint: combine ETA + turn progress + last log line (all visible when available)
      const hintParts: string[] = []
      if (s.state === 'running' && s.estimatedEndAt) {
        const rem = s.estimatedEndAt.getTime() - Date.now()
        if (rem > 0) {
          const remSec = Math.floor(rem / 1000)
          hintParts.push(`~${remSec < 60 ? remSec + 's' : Math.ceil(remSec / 60) + 'm'} left`)
        }
      }
      if (s.state === 'running' && s.currentTurn && s.maxTurns) {
        hintParts.push(`t${s.currentTurn}/${s.maxTurns}`)
      }
      if (s.lastLine) hintParts.push(s.lastLine.replace(/\s+/g, ' '))
      const hintText = hintParts.join(' · ')

      const nameStr = trunc(s.repo, W_NAME)
      const taskStr = trunc(s.taskId, W_TASK)
      const timeStr = elapsed(s).padStart(W_TIME).slice(0, W_TIME)
      const hintStr = trunc(hintText, W_HINT)

      const nameColored = (s.state === 'running' ? chalk.white.bold : chalk.gray)(nameStr)
      const taskColored = chalk.yellow(taskStr)
      const timeColored = chalk.gray(timeStr)
      const hintColored =
        s.state === 'done'   ? chalk.green(hintStr) :
        s.state === 'failed' ? chalk.red(hintStr)   :
        chalk.gray(hintStr)

      lines.push(
        chalk.gray('│ ') + icon + chalk.gray(' │ ') + nameColored +
        chalk.gray(' │ ') + taskColored +
        chalk.gray(' │ ') + timeColored +
        chalk.gray(' │ ') + hintColored +
        chalk.gray(' │')
      )
    }

    lines.push(divider('└', '┴', '┘'))
    lines.push(chalk.gray('  aahp logs <repo> for details'))
    lines.push('')  // trailing newline

    this._headerLines = termRowCount(lines, termWidth)
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
