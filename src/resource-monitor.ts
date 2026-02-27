import { exec } from 'child_process'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResourceSnapshot {
  cpuPercent: number  // 0-100+
  memMB: number       // resident memory in MB
  timestamp: number   // Date.now()
}

// ── Cross-platform PID resource polling ──────────────────────────────────────

function queryPidUnix(pid: number): Promise<ResourceSnapshot | undefined> {
  return new Promise(resolve => {
    exec(`ps -p ${pid} -o %cpu=,rss=`, { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(undefined); return }
      const parts = stdout.trim().split(/\s+/)
      const cpu = parseFloat(parts[0] ?? '0')
      const rssKB = parseInt(parts[1] ?? '0', 10)
      resolve({ cpuPercent: cpu, memMB: Math.round(rssKB / 1024), timestamp: Date.now() })
    })
  })
}

function queryPidWindows(pid: number): Promise<ResourceSnapshot | undefined> {
  return new Promise(resolve => {
    // Use PowerShell for reliable Windows process metrics
    const cmd = `powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object CPU,WorkingSet64 | ConvertTo-Json"`
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(undefined); return }
      try {
        const data = JSON.parse(stdout.trim()) as { CPU?: number; WorkingSet64?: number }
        // CPU is total processor time in seconds; approximate % from delta
        const memMB = Math.round((data.WorkingSet64 ?? 0) / (1024 * 1024))
        resolve({ cpuPercent: data.CPU ?? 0, memMB, timestamp: Date.now() })
      } catch {
        resolve(undefined)
      }
    })
  })
}

async function queryPid(pid: number): Promise<ResourceSnapshot | undefined> {
  return process.platform === 'win32' ? queryPidWindows(pid) : queryPidUnix(pid)
}

/** Get a snapshot of the current process (for SDK backend running in-process) */
export function currentProcessSnapshot(): ResourceSnapshot {
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  // cpuUsage returns microseconds; approximate % over a 1-second window
  const totalCpuUs = cpu.user + cpu.system
  const cpuPercent = Math.round(totalCpuUs / 10000) // rough approximation
  return {
    cpuPercent: Math.min(cpuPercent, 100),
    memMB: Math.round(mem.rss / (1024 * 1024)),
    timestamp: Date.now(),
  }
}

// ── ResourceMonitor class ────────────────────────────────────────────────────

export class ResourceMonitor {
  private _pid: number
  private _interval: ReturnType<typeof setInterval> | undefined
  private _snapshots: ResourceSnapshot[] = []
  private _onUpdate?: (snapshot: ResourceSnapshot) => void
  private _pollMs: number

  constructor(pid: number, pollMs: number = 2000) {
    this._pid = pid
    this._pollMs = pollMs
  }

  /** Start polling resource usage. Calls onUpdate with each snapshot. */
  start(onUpdate?: (snapshot: ResourceSnapshot) => void): void {
    this._onUpdate = onUpdate
    this._interval = setInterval(async () => {
      const snap = await queryPid(this._pid)
      if (snap) {
        this._snapshots.push(snap)
        this._onUpdate?.(snap)
      }
    }, this._pollMs)
  }

  /** Stop polling */
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = undefined
    }
  }

  /** Get the latest snapshot */
  latest(): ResourceSnapshot | undefined {
    return this._snapshots[this._snapshots.length - 1]
  }

  /** Average CPU % across all snapshots */
  avgCpu(): number {
    if (this._snapshots.length === 0) return 0
    const total = this._snapshots.reduce((s, snap) => s + snap.cpuPercent, 0)
    return Math.round(total / this._snapshots.length)
  }

  /** Peak memory in MB */
  peakMemMB(): number {
    if (this._snapshots.length === 0) return 0
    return Math.max(...this._snapshots.map(s => s.memMB))
  }

  /** All collected snapshots */
  snapshots(): ResourceSnapshot[] {
    return [...this._snapshots]
  }
}
