import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...config }, null, 2), 'utf8')
}

export function registerWindowsScheduler(time: string, rootDir: string): void {
  const [hour, minute] = time.split(':')
  const nodePath = process.execPath
  const scriptPath = path.resolve(process.argv[1] ?? 'aahp-runner')

  // Build the schtasks command
  const taskName = 'AAHP-Runner-Daily'
  const action = `"${nodePath}" "${scriptPath}" run --all --root "${rootDir}" --yes`
  const trigger = `/SC DAILY /ST ${hour?.padStart(2, '0')}:${minute?.padStart(2, '0')}`

  try {
    // Delete existing task if present
    execSync(`schtasks /Delete /TN "${taskName}" /F 2>nul`, { stdio: 'ignore' })
  } catch { /* ignore */ }

  execSync(
    `schtasks /Create /TN "${taskName}" /TR "${action}" ${trigger} /RL HIGHEST /F`,
    { encoding: 'utf8' }
  )

  console.log(`\n✅ Scheduled: ${taskName}`)
  console.log(`   Runs daily at ${time}`)
  console.log(`   Command: ${action}`)
  console.log(`\n   View in Windows: Task Scheduler → "${taskName}"`)
  console.log(`   To remove: schtasks /Delete /TN "${taskName}" /F`)
}
