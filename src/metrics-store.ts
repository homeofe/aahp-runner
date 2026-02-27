import * as fs from 'fs'
import * as path from 'path'
import os from 'os'

// ── Types ────────────────────────────────────────────────────────────────────

export interface RunMetric {
  timestamp: string       // ISO 8601
  repo: string
  taskId: string
  taskTitle: string
  backend: string
  durationMs: number
  turns: number
  success: boolean
  committed: boolean
  cpuAvg?: number         // average CPU % during run
  memPeakMB?: number      // peak memory in MB
}

export interface MetricsSummary {
  totalRuns: number
  successCount: number
  failCount: number
  successRate: number     // 0-100
  avgDurationMs: number
  totalDurationMs: number
  byRepo: Record<string, { runs: number; successes: number; avgMs: number }>
  byBackend: Record<string, { runs: number; successes: number }>
  daily: Array<{ date: string; runs: number; successes: number }>
}

// ── Store ────────────────────────────────────────────────────────────────────

const METRICS_DIR = path.join(os.homedir(), '.aahp')
const METRICS_FILE = path.join(METRICS_DIR, 'metrics.jsonl')

/** Append a run metric to the JSONL file */
export function recordMetric(entry: RunMetric): void {
  fs.mkdirSync(METRICS_DIR, { recursive: true })
  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(METRICS_FILE, line, 'utf8')
}

/** Load all metrics, optionally filtered by date range or repo */
export function loadMetrics(filter?: {
  repo?: string
  since?: Date
  until?: Date
}): RunMetric[] {
  if (!fs.existsSync(METRICS_FILE)) return []

  const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean)
  let metrics: RunMetric[] = []

  for (const line of lines) {
    try {
      metrics.push(JSON.parse(line) as RunMetric)
    } catch {
      // skip malformed lines
    }
  }

  if (filter?.repo) {
    metrics = metrics.filter(m => m.repo === filter.repo)
  }
  if (filter?.since) {
    const since = filter.since.getTime()
    metrics = metrics.filter(m => new Date(m.timestamp).getTime() >= since)
  }
  if (filter?.until) {
    const until = filter.until.getTime()
    metrics = metrics.filter(m => new Date(m.timestamp).getTime() <= until)
  }

  return metrics
}

/** Compute aggregate summary from a set of metrics */
export function summarizeMetrics(metrics: RunMetric[]): MetricsSummary {
  const totalRuns = metrics.length
  const successCount = metrics.filter(m => m.success).length
  const failCount = totalRuns - successCount
  const successRate = totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) : 0
  const totalDurationMs = metrics.reduce((sum, m) => sum + m.durationMs, 0)
  const avgDurationMs = totalRuns > 0 ? Math.round(totalDurationMs / totalRuns) : 0

  // By repo
  const byRepo: MetricsSummary['byRepo'] = {}
  for (const m of metrics) {
    const r = byRepo[m.repo] ?? (byRepo[m.repo] = { runs: 0, successes: 0, avgMs: 0 })
    r.runs++
    if (m.success) r.successes++
  }
  for (const repo of Object.keys(byRepo)) {
    const r = byRepo[repo]!
    const repoMetrics = metrics.filter(m => m.repo === repo)
    r.avgMs = Math.round(repoMetrics.reduce((s, m) => s + m.durationMs, 0) / r.runs)
  }

  // By backend
  const byBackend: MetricsSummary['byBackend'] = {}
  for (const m of metrics) {
    const b = byBackend[m.backend] ?? (byBackend[m.backend] = { runs: 0, successes: 0 })
    b.runs++
    if (m.success) b.successes++
  }

  // Daily aggregation (last 7 days)
  const dayMap = new Map<string, { runs: number; successes: number }>()
  for (const m of metrics) {
    const date = m.timestamp.slice(0, 10)
    const d = dayMap.get(date) ?? { runs: 0, successes: 0 }
    d.runs++
    if (m.success) d.successes++
    dayMap.set(date, d)
  }
  const daily = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({ date, ...stats }))

  return { totalRuns, successCount, failCount, successRate, avgDurationMs, totalDurationMs, byRepo, byBackend, daily }
}

/** Get average duration for a specific repo (for ETA prediction) */
export function getAvgDuration(repo: string): number | undefined {
  const metrics = loadMetrics({ repo })
  const successful = metrics.filter(m => m.success)
  if (successful.length === 0) return undefined
  // Use last 10 runs for a rolling average
  const recent = successful.slice(-10)
  return Math.round(recent.reduce((s, m) => s + m.durationMs, 0) / recent.length)
}

/** Path to the metrics file (for external tooling) */
export function metricsFilePath(): string {
  return METRICS_FILE
}
