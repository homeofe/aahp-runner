import * as fs from 'fs'
import * as path from 'path'
import { execFileSync, execSync } from 'child_process'
import os from 'os'

const CONFIG_PATH = path.join(os.homedir(), '.aahp-runner.json')
const CRON_MARKER = '# AAHP-Runner-Daily'

export interface RunnerConfig {
  rootDir: string
  apiKey: string
  scheduledTime?: string  // HH:MM format
  maxConcurrent?: number
  backend?: 'auto' | 'claude' | 'gemini' | 'codex' | 'copilot' | 'sdk'
  model?: string          // model override passed to the chosen backend (e.g. "gemini-2.5-flash", "claude-sonnet-4-5")
  timeoutMinutes?: number  // per-agent timeout (default: 10)
  alerts?: AlertConfig
}

export interface AlertConfig {
  webhook?: string       // Generic HTTP POST URL
  slack?: string         // Slack incoming webhook URL
  events?: AlertEvent[]
}

export type AlertEvent = 'run_complete' | 'agent_failed' | 'all_done'

export function loadConfig(): Partial<RunnerConfig> {
  if (!fs.existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<RunnerConfig>
  } catch {
    return {}
  }
}

export function saveConfig(config: Partial<RunnerConfig>): void {
  const existing = loadConfig()
  // Note: config file may contain API key in plaintext - permissions are set to owner-only
  // as a mitigation, but consider using OS keychain for production deployments
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...config }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/** Validate shared scheduler parameters. Throws on invalid input. */
export function validateSchedulerArgs(time: string, rootDir: string): { hour: string; minute: string } {
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Invalid time format "${time}" - expected HH:MM (e.g. "02:00")`)
  }
  if (!path.isAbsolute(rootDir)) {
    throw new Error(`rootDir must be an absolute path, got: "${rootDir}"`)
  }
  if (!fs.existsSync(rootDir)) {
    throw new Error(`rootDir does not exist: "${rootDir}"`)
  }
  const [hour, minute] = time.split(':')
  return { hour: hour!.padStart(2, '0'), minute: minute!.padStart(2, '0') }
}

export function registerWindowsScheduler(time: string, rootDir: string): void {
  const { hour, minute } = validateSchedulerArgs(time, rootDir)

  const nodePath = process.execPath
  const scriptPath = path.resolve(process.argv[1] ?? 'aahp-runner')

  const taskName = 'AAHP-Runner-Daily'
  const action = `"${nodePath}" "${scriptPath}" run --all --root "${rootDir}" --yes`
  const startTime = `${hour}:${minute}`

  try {
    // Delete existing task if present
    execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' })
  } catch { /* ignore - task may not exist yet */ }

  execFileSync('schtasks', [
    '/Create', '/TN', taskName,
    '/TR', action,
    '/SC', 'DAILY',
    '/ST', startTime,
    '/RL', 'HIGHEST',
    '/F',
  ], { encoding: 'utf8' })

  console.log(`\nScheduled: ${taskName}`)
  console.log(`   Runs daily at ${time}`)
  console.log(`   Command: ${action}`)
  console.log(`\n   View in Windows: Task Scheduler - "${taskName}"`)
  console.log(`   To remove: schtasks /Delete /TN "${taskName}" /F`)
}

/** Build the cron command string for the AAHP runner. */
export function buildCronCommand(rootDir: string): string {
  const nodePath = process.execPath
  const scriptPath = path.resolve(process.argv[1] ?? 'aahp-runner')
  return `"${nodePath}" "${scriptPath}" run --all --root "${rootDir}" --yes`
}

/** Build a full crontab line with the marker comment. */
export function buildCronLine(minute: string, hour: string, rootDir: string): string {
  const command = buildCronCommand(rootDir)
  return `${minute} ${hour} * * * ${command} ${CRON_MARKER}`
}

/** Read current user crontab. Returns empty string if none exists. */
export function readCrontab(): string {
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' })
  } catch {
    return ''
  }
}

/** Write a new crontab from a string. */
export function writeCrontab(content: string): void {
  // Write to temp file, then install via crontab command
  const tmpFile = path.join(os.tmpdir(), `aahp-crontab-${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmpFile, content, { encoding: 'utf8', mode: 0o600 })
    execFileSync('crontab', [tmpFile], { encoding: 'utf8' })
  } finally {
    try { fs.unlinkSync(tmpFile) } catch { /* cleanup best-effort */ }
  }
}

/** Remove existing AAHP cron entries from crontab content. */
export function removeCronEntries(crontab: string): string {
  return crontab
    .split('\n')
    .filter(line => !line.includes(CRON_MARKER))
    .join('\n')
}

export function registerCronScheduler(time: string, rootDir: string): void {
  const { hour, minute } = validateSchedulerArgs(time, rootDir)

  const cronLine = buildCronLine(minute, hour, rootDir)

  // Read existing crontab, remove old AAHP entries, append new one
  const existing = readCrontab()
  const cleaned = removeCronEntries(existing)
  const newCrontab = (cleaned.endsWith('\n') || cleaned === '' ? cleaned : cleaned + '\n') + cronLine + '\n'

  writeCrontab(newCrontab)

  console.log(`\nScheduled: AAHP-Runner-Daily (cron)`)
  console.log(`   Runs daily at ${time}`)
  console.log(`   Cron expression: ${minute} ${hour} * * *`)
  console.log(`   Command: ${buildCronCommand(rootDir)}`)
  console.log(`\n   View: crontab -l`)
  console.log(`   To remove: crontab -l | grep -v '${CRON_MARKER}' | crontab -`)
}

/** Register a daily schedule using the appropriate OS mechanism. */
export function registerScheduler(time: string, rootDir: string): void {
  if (process.platform === 'win32') {
    registerWindowsScheduler(time, rootDir)
  } else {
    registerCronScheduler(time, rootDir)
  }
}

/** Remove the scheduled AAHP runner job for the current OS. */
export function unregisterScheduler(): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', 'AAHP-Runner-Daily', '/F'], { encoding: 'utf8' })
      console.log('Removed Windows scheduled task: AAHP-Runner-Daily')
    } catch {
      console.log('No Windows scheduled task found to remove.')
    }
  } else {
    const existing = readCrontab()
    if (existing.includes(CRON_MARKER)) {
      const cleaned = removeCronEntries(existing)
      writeCrontab(cleaned)
      console.log('Removed AAHP cron entry.')
    } else {
      console.log('No AAHP cron entry found to remove.')
    }
  }
}
