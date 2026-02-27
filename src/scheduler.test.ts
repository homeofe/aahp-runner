import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  registerWindowsScheduler,
  validateSchedulerArgs,
  buildCronLine,
  removeCronEntries,
  registerCronScheduler,
  registerScheduler,
} from './scheduler.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-sched-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ── validateSchedulerArgs ────────────────────────────────────────────────────

describe('validateSchedulerArgs', () => {
  it('rejects invalid time format (letters)', () => {
    expect(() => validateSchedulerArgs('abc', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects invalid time format (single digit)', () => {
    expect(() => validateSchedulerArgs('2:00', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects invalid time format (no colon)', () => {
    expect(() => validateSchedulerArgs('0200', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects relative rootDir', () => {
    expect(() => validateSchedulerArgs('02:00', './relative'))
      .toThrow('rootDir must be an absolute path')
  })

  it('rejects non-existent rootDir', () => {
    const fakePath = path.join(tmpDir, 'nonexistent')
    expect(() => validateSchedulerArgs('02:00', fakePath))
      .toThrow('rootDir does not exist')
  })

  it('parses valid time and returns padded hour/minute', () => {
    const result = validateSchedulerArgs('02:30', tmpDir)
    expect(result).toEqual({ hour: '02', minute: '30' })
  })

  it('pads single-digit-like hours correctly', () => {
    // Already validated as 2-digit, so this just confirms padding is idempotent
    const result = validateSchedulerArgs('09:05', tmpDir)
    expect(result).toEqual({ hour: '09', minute: '05' })
  })
})

// ── registerWindowsScheduler input validation ────────────────────────────────
// (preserves original tests - they still use the same validation under the hood)

describe('registerWindowsScheduler', () => {
  it('rejects invalid time format (letters)', () => {
    expect(() => registerWindowsScheduler('abc', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects invalid time format (single digit)', () => {
    expect(() => registerWindowsScheduler('2:00', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects invalid time format (no colon)', () => {
    expect(() => registerWindowsScheduler('0200', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects relative rootDir', () => {
    expect(() => registerWindowsScheduler('02:00', './relative'))
      .toThrow('rootDir must be an absolute path')
  })

  it('rejects non-existent rootDir', () => {
    const fakePath = path.join(tmpDir, 'nonexistent')
    expect(() => registerWindowsScheduler('02:00', fakePath))
      .toThrow('rootDir does not exist')
  })
})

// ── buildCronLine ────────────────────────────────────────────────────────────

describe('buildCronLine', () => {
  it('produces a valid cron line with minute, hour, and marker', () => {
    const line = buildCronLine('30', '02', '/home/user/dev')
    expect(line).toMatch(/^30 02 \* \* \* .+ run --all --root "\/home\/user\/dev" --yes # AAHP-Runner-Daily$/)
  })

  it('includes node and script paths in the command', () => {
    const line = buildCronLine('00', '04', '/opt/projects')
    expect(line).toContain(process.execPath)
    expect(line).toContain('run --all')
    expect(line).toContain('# AAHP-Runner-Daily')
  })
})

// ── removeCronEntries ────────────────────────────────────────────────────────

describe('removeCronEntries', () => {
  it('removes lines containing the AAHP marker', () => {
    const crontab = [
      '0 5 * * * /usr/bin/backup',
      '30 2 * * * /usr/bin/node aahp run --all # AAHP-Runner-Daily',
      '*/10 * * * * /usr/bin/healthcheck',
    ].join('\n')

    const result = removeCronEntries(crontab)
    expect(result).not.toContain('AAHP-Runner-Daily')
    expect(result).toContain('backup')
    expect(result).toContain('healthcheck')
  })

  it('returns empty string if all lines are AAHP entries', () => {
    const crontab = '30 2 * * * something # AAHP-Runner-Daily\n'
    const result = removeCronEntries(crontab)
    expect(result.trim()).toBe('')
  })

  it('preserves crontab with no AAHP entries unchanged', () => {
    const crontab = '0 5 * * * /usr/bin/backup\n*/10 * * * * /usr/bin/healthcheck\n'
    const result = removeCronEntries(crontab)
    expect(result).toBe(crontab)
  })

  it('handles empty crontab', () => {
    expect(removeCronEntries('')).toBe('')
  })
})

// ── registerCronScheduler ────────────────────────────────────────────────────

describe('registerCronScheduler', () => {
  it('rejects invalid time format', () => {
    expect(() => registerCronScheduler('bad', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects relative rootDir', () => {
    expect(() => registerCronScheduler('02:00', 'relative/path'))
      .toThrow('rootDir must be an absolute path')
  })

  it('rejects non-existent rootDir', () => {
    const fakePath = path.join(tmpDir, 'nope')
    expect(() => registerCronScheduler('02:00', fakePath))
      .toThrow('rootDir does not exist')
  })
})

// ── registerScheduler (cross-platform dispatcher) ────────────────────────────

describe('registerScheduler', () => {
  it('rejects invalid time on any platform', () => {
    expect(() => registerScheduler('nope', tmpDir))
      .toThrow('Invalid time format')
  })

  it('rejects relative rootDir on any platform', () => {
    expect(() => registerScheduler('02:00', 'rel'))
      .toThrow('rootDir must be an absolute path')
  })
})

// ── Config load/save ─────────────────────────────────────────────────────────
// Note: loadConfig/saveConfig use a hardcoded path (~/.aahp-runner.json)
// so we test them indirectly or skip to avoid modifying user home files.
// The validation in registerWindowsScheduler/registerCronScheduler is the key testable surface.
