import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import os from 'os'

const CONFIG_PATH = path.join(os.homedir(), '.aahp-runner.json')

export interface RunnerConfig {
  rootDir: string
  apiKey: string
  scheduledTime?: string  // HH:MM format
  maxConcurrent?: number
}

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

export function registerWindowsScheduler(time: string, rootDir: string): void {
  // Validate time parameter to prevent injection
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Invalid time format "${time}" - expected HH:MM (e.g. "02:00")`)
  }
  // Validate rootDir is an absolute path and exists
  if (!path.isAbsolute(rootDir)) {
    throw new Error(`rootDir must be an absolute path, got: "${rootDir}"`)
  }
  if (!fs.existsSync(rootDir)) {
    throw new Error(`rootDir does not exist: "${rootDir}"`)
  }

  const [hour, minute] = time.split(':')
  const nodePath = process.execPath
  const scriptPath = path.resolve(process.argv[1] ?? 'aahp-runner')

  const taskName = 'AAHP-Runner-Daily'
  const action = `"${nodePath}" "${scriptPath}" run --all --root "${rootDir}" --yes`
  const startTime = `${hour?.padStart(2, '0')}:${minute?.padStart(2, '0')}`

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
