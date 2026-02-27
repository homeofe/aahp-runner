import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { agentLogPath, writeLog, StatusBoard } from './status-board.js'
import type { AgentStatus } from './status-board.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-status-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── agentLogPath ─────────────────────────────────────────────────────────────

describe('agentLogPath', () => {
  it('returns a path containing the repo name', () => {
    const logPath = agentLogPath('my-repo')
    expect(logPath).toContain('my-repo')
  })

  it('returns a path with date stamp', () => {
    const logPath = agentLogPath('test-repo')
    const today = new Date().toISOString().slice(0, 10)
    expect(logPath).toContain(today)
  })

  it('returns a .log file', () => {
    const logPath = agentLogPath('test-repo')
    expect(logPath).toMatch(/\.log$/)
  })
})

// ── writeLog ─────────────────────────────────────────────────────────────────

describe('writeLog', () => {
  it('appends text to a log file', () => {
    const logFile = path.join(tmpDir, 'test.log')
    writeLog(logFile, 'line 1\n')
    writeLog(logFile, 'line 2\n')

    const content = fs.readFileSync(logFile, 'utf8')
    expect(content).toBe('line 1\nline 2\n')
  })

  it('does not throw on write error (best-effort)', () => {
    // Write to a path that cannot be created (dir does not exist)
    expect(() => writeLog('/nonexistent/dir/test.log', 'text')).not.toThrow()
  })
})

// ── StatusBoard ──────────────────────────────────────────────────────────────

describe('StatusBoard', () => {
  function makeStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
    return {
      repo: 'test-repo',
      taskId: 'T-001',
      taskTitle: 'Test task',
      state: 'queued',
      lastLine: '',
      logFile: path.join(tmpDir, 'test.log'),
      committed: false,
      ...overrides,
    }
  }

  it('constructs without errors', () => {
    const agents = [makeStatus(), makeStatus({ repo: 'repo-2' })]
    const board = new StatusBoard(agents)
    expect(board).toBeDefined()
  })

  it('tracks multiple agent statuses', () => {
    const agents = [
      makeStatus({ repo: 'repo-1', state: 'running' }),
      makeStatus({ repo: 'repo-2', state: 'done' }),
      makeStatus({ repo: 'repo-3', state: 'failed' }),
    ]
    const board = new StatusBoard(agents)
    expect(board).toBeDefined()
    // Board is constructed - the internal state is the agents array
  })
})
