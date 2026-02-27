import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { registerWindowsScheduler } from './scheduler.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-sched-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── registerWindowsScheduler input validation ────────────────────────────────

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

// ── Config load/save ─────────────────────────────────────────────────────────
// Note: loadConfig/saveConfig use a hardcoded path (~/.aahp-runner.json)
// so we test them indirectly or skip to avoid modifying user home files.
// The validation in registerWindowsScheduler is the key testable surface.
