import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ── Shared paths (same as aahp-runner) ───────────────────────────────────────

const AAHP_DIR = path.join(os.homedir(), '.aahp')
const METRICS_FILE = path.join(AAHP_DIR, 'metrics.jsonl')
const SESSIONS_FILE = path.join(AAHP_DIR, 'sessions.json')
const LOG_DIR = path.join(AAHP_DIR, 'logs')
const CONFIG_FILE = path.join(os.homedir(), '.aahp-runner.json')

// ── Types ────────────────────────────────────────────────────────────────────

export interface LiveSession {
  repoPath: string
  repoName: string
  taskId: string
  taskTitle: string
  backend: string
  startedAt: string
}

export interface RunMetric {
  timestamp: string
  repo: string
  taskId: string
  taskTitle: string
  backend: string
  durationMs: number
  turns: number
  success: boolean
  committed: boolean
  cpuAvg?: number
  memPeakMB?: number
}

export interface RunnerConfig {
  rootDir?: string
  apiKey?: string
  scheduledTime?: string
  maxConcurrent?: number
  backend?: string
  timeoutMinutes?: number
  alerts?: {
    webhook?: string
    slack?: string
    events?: string[]
  }
}

// ── Readers ──────────────────────────────────────────────────────────────────

export function readLiveSessions(): LiveSession[] {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return []
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as { sessions?: unknown[] }
    return Array.isArray(data.sessions) ? data.sessions as LiveSession[] : []
  } catch { return [] }
}

export function readMetrics(limit?: number): RunMetric[] {
  try {
    if (!fs.existsSync(METRICS_FILE)) return []
    const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean)
    const metrics: RunMetric[] = []
    for (const line of lines) {
      try { metrics.push(JSON.parse(line) as RunMetric) } catch { /* skip */ }
    }
    return limit ? metrics.slice(-limit) : metrics
  } catch { return [] }
}

export function readConfig(): RunnerConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as RunnerConfig
  } catch { return {} }
}

export function getLogFiles(): Array<{ name: string; path: string; sizeKB: number; modified: Date }> {
  try {
    if (!fs.existsSync(LOG_DIR)) return []
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const fullPath = path.join(LOG_DIR, f)
        const stat = fs.statSync(fullPath)
        return { name: f.replace('.log', ''), path: fullPath, sizeKB: Math.round(stat.size / 1024), modified: stat.mtime }
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
  } catch { return [] }
}

export function getLastLogLine(repoName: string): string {
  try {
    const stamp = new Date().toISOString().slice(0, 10)
    const logPath = path.join(LOG_DIR, `${repoName}-${stamp}.log`)
    if (!fs.existsSync(logPath)) return ''
    const content = fs.readFileSync(logPath, 'utf8')
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('='))
    const last = lines[lines.length - 1] ?? ''
    return last.replace(/\s+/g, ' ').slice(0, 80)
  } catch { return '' }
}

export function computeSummary(metrics: RunMetric[]): {
  totalRuns: number
  successRate: number
  avgDurationMs: number
  byRepo: Record<string, { runs: number; successes: number; avgMs: number }>
} {
  const totalRuns = metrics.length
  const successes = metrics.filter(m => m.success).length
  const successRate = totalRuns > 0 ? Math.round((successes / totalRuns) * 100) : 0
  const avgDurationMs = totalRuns > 0 ? Math.round(metrics.reduce((s, m) => s + m.durationMs, 0) / totalRuns) : 0

  const byRepo: Record<string, { runs: number; successes: number; avgMs: number }> = {}
  for (const m of metrics) {
    const r = byRepo[m.repo] ?? (byRepo[m.repo] = { runs: 0, successes: 0, avgMs: 0 })
    r.runs++
    if (m.success) r.successes++
  }
  for (const repo of Object.keys(byRepo)) {
    const r = byRepo[repo]!
    const repoMs = metrics.filter(m => m.repo === repo).reduce((s, m) => s + m.durationMs, 0)
    r.avgMs = Math.round(repoMs / r.runs)
  }

  return { totalRuns, successRate, avgDurationMs, byRepo }
}
