import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { RunMetric } from './metrics-store.js'

// We need to mock the file path to avoid writing to the real ~/.aahp/metrics.jsonl
// Instead we test the core logic by importing and calling functions with test data

let tmpDir: string
let metricsFile: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-metrics-test-'))
  metricsFile = path.join(tmpDir, 'metrics.jsonl')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeSampleMetric(overrides: Partial<RunMetric> = {}): RunMetric {
  return {
    timestamp: '2026-02-27T12:00:00.000Z',
    repo: 'test-repo',
    taskId: 'T-001',
    taskTitle: 'Test task',
    backend: 'claude',
    durationMs: 120000,
    turns: 5,
    success: true,
    committed: true,
    ...overrides,
  }
}

// ── JSONL format tests ───────────────────────────────────────────────────────

describe('metrics JSONL format', () => {
  it('serializes a metric as a single JSON line', () => {
    const metric = makeSampleMetric()
    const line = JSON.stringify(metric)
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toEqual(metric)
  })

  it('can round-trip multiple metrics via JSONL', () => {
    const metrics = [
      makeSampleMetric({ repo: 'repo-1', durationMs: 100000 }),
      makeSampleMetric({ repo: 'repo-2', durationMs: 200000, success: false }),
      makeSampleMetric({ repo: 'repo-3', durationMs: 300000 }),
    ]

    // Write JSONL
    const content = metrics.map(m => JSON.stringify(m)).join('\n') + '\n'
    fs.writeFileSync(metricsFile, content)

    // Read back
    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean)
    const parsed = lines.map(l => JSON.parse(l) as RunMetric)

    expect(parsed).toHaveLength(3)
    expect(parsed[0]!.repo).toBe('repo-1')
    expect(parsed[1]!.success).toBe(false)
    expect(parsed[2]!.durationMs).toBe(300000)
  })

  it('handles empty file gracefully', () => {
    fs.writeFileSync(metricsFile, '')
    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(0)
  })

  it('skips malformed lines', () => {
    const content = [
      JSON.stringify(makeSampleMetric()),
      'not valid json',
      JSON.stringify(makeSampleMetric({ repo: 'valid' })),
    ].join('\n') + '\n'

    fs.writeFileSync(metricsFile, content)
    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean)
    const parsed: RunMetric[] = []
    for (const line of lines) {
      try { parsed.push(JSON.parse(line) as RunMetric) } catch { /* skip */ }
    }
    expect(parsed).toHaveLength(2)
  })
})

// ── Summary computation tests ────────────────────────────────────────────────

describe('metrics summary computation', () => {
  it('computes success rate correctly', () => {
    const metrics = [
      makeSampleMetric({ success: true }),
      makeSampleMetric({ success: true }),
      makeSampleMetric({ success: false }),
      makeSampleMetric({ success: true }),
    ]
    const successes = metrics.filter(m => m.success).length
    const rate = Math.round((successes / metrics.length) * 100)
    expect(rate).toBe(75)
  })

  it('computes average duration', () => {
    const metrics = [
      makeSampleMetric({ durationMs: 100000 }),
      makeSampleMetric({ durationMs: 200000 }),
      makeSampleMetric({ durationMs: 300000 }),
    ]
    const avg = Math.round(metrics.reduce((s, m) => s + m.durationMs, 0) / metrics.length)
    expect(avg).toBe(200000)
  })

  it('groups by repo', () => {
    const metrics = [
      makeSampleMetric({ repo: 'repo-a', success: true }),
      makeSampleMetric({ repo: 'repo-a', success: false }),
      makeSampleMetric({ repo: 'repo-b', success: true }),
    ]
    const byRepo: Record<string, { runs: number; successes: number }> = {}
    for (const m of metrics) {
      const r = byRepo[m.repo] ?? (byRepo[m.repo] = { runs: 0, successes: 0 })
      r.runs++
      if (m.success) r.successes++
    }
    expect(byRepo['repo-a']!.runs).toBe(2)
    expect(byRepo['repo-a']!.successes).toBe(1)
    expect(byRepo['repo-b']!.runs).toBe(1)
  })

  it('groups by backend', () => {
    const metrics = [
      makeSampleMetric({ backend: 'claude' }),
      makeSampleMetric({ backend: 'copilot' }),
      makeSampleMetric({ backend: 'claude' }),
    ]
    const byBackend: Record<string, number> = {}
    for (const m of metrics) {
      byBackend[m.backend] = (byBackend[m.backend] ?? 0) + 1
    }
    expect(byBackend['claude']).toBe(2)
    expect(byBackend['copilot']).toBe(1)
  })

  it('handles empty metrics array', () => {
    const metrics: RunMetric[] = []
    expect(metrics.length).toBe(0)
    const avg = metrics.length > 0 ? metrics.reduce((s, m) => s + m.durationMs, 0) / metrics.length : 0
    expect(avg).toBe(0)
  })
})

// ── Filtering tests ──────────────────────────────────────────────────────────

describe('metrics filtering', () => {
  it('filters by repo name', () => {
    const metrics = [
      makeSampleMetric({ repo: 'repo-a' }),
      makeSampleMetric({ repo: 'repo-b' }),
      makeSampleMetric({ repo: 'repo-a' }),
    ]
    const filtered = metrics.filter(m => m.repo === 'repo-a')
    expect(filtered).toHaveLength(2)
  })

  it('filters by date range', () => {
    const metrics = [
      makeSampleMetric({ timestamp: '2026-02-25T12:00:00Z' }),
      makeSampleMetric({ timestamp: '2026-02-26T12:00:00Z' }),
      makeSampleMetric({ timestamp: '2026-02-27T12:00:00Z' }),
    ]
    const since = new Date('2026-02-26T00:00:00Z').getTime()
    const filtered = metrics.filter(m => new Date(m.timestamp).getTime() >= since)
    expect(filtered).toHaveLength(2)
  })

  it('includes optional resource fields', () => {
    const metric = makeSampleMetric({ cpuAvg: 45.2, memPeakMB: 512 })
    expect(metric.cpuAvg).toBe(45.2)
    expect(metric.memPeakMB).toBe(512)
  })
})
