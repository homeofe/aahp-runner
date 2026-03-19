/**
 * Tests for agent execution logic (T-007)
 *
 * Covers:
 *  - Backend detection / resolveBackend auto-selection
 *  - runAgent dispatches to correct backend (claude-cli, copilot, sdk, none)
 *  - Task selection from NEXT_ACTIONS via getTopTask
 *  - MANIFEST.json update (markTaskDone) after successful commit
 *  - LOG.md result logging via writeLog / agentLogPath
 *  - runViaSDK: multi-turn loop, tool execution, committed detection
 *  - runViaCopilot: tool calls, error handling (401, network)
 *  - runViaClaudeCLI: spawn, timeout, commit detection
 *  - Error handling: backend 'none' throws descriptive error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventEmitter } from 'events'

// ── Types ─────────────────────────────────────────────────────────────────────
import type { AahpManifest, AahpProject, AahpTask } from './types.js'

// ── ESM-compatible mock for child_process.spawn ───────────────────────────────
// Must be declared before any imports that transitively use child_process.spawn.
// We create a shared mutable ref the factory closure can update between tests.
let _spawnMockImpl: (() => any) | null = null

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: any[]) => {
      if (_spawnMockImpl) return _spawnMockImpl()
      return actual.spawn(...args)
    },
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string

function makeTmpRepo(name = 'test-repo'): string {
  const repoPath = path.join(tmpDir, name)
  const handoffDir = path.join(repoPath, '.ai', 'handoff')
  fs.mkdirSync(handoffDir, { recursive: true })
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true })
  fs.writeFileSync(path.join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return repoPath
}

function writeManifest(repoPath: string, manifest: AahpManifest): void {
  const handoffDir = path.join(repoPath, '.ai', 'handoff')
  fs.mkdirSync(handoffDir, { recursive: true })
  fs.writeFileSync(
    path.join(handoffDir, 'MANIFEST.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
}

function makeManifest(overrides: Partial<AahpManifest> = {}): AahpManifest {
  return {
    aahp_version: '3.0',
    project: 'test-project',
    last_session: {
      agent: 'test-agent',
      timestamp: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      phase: 'implement',
      duration_minutes: 5,
    },
    files: {},
    quick_context: 'A test project for agent execution tests',
    token_budget: { manifest_only: 80 },
    tasks: {},
    ...overrides,
  }
}

function makeTask(overrides: Partial<AahpTask> = {}): AahpTask {
  return {
    title: 'Test task',
    status: 'ready',
    priority: 'medium',
    depends_on: [],
    created: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeProject(repoPath: string, overrides: Partial<AahpProject> = {}): AahpProject {
  const handoffDir = path.join(repoPath, '.ai', 'handoff')
  const manifest = makeManifest({ tasks: { 'T-001': makeTask({ title: 'Implement feature X' }) } })
  return {
    name: 'test-project',
    repoPath,
    handoffDir,
    manifest,
    readyTasks: [['T-001', manifest.tasks!['T-001']!]],
    activeTasks: [],
    blockedTasks: [],
    cancelledTasks: [],
    doneTasks: [],
    isLocalOnly: true,
    ...overrides,
  }
}

/** Build a fake mock process that emits events like a spawned child */
function makeMockProc(pid = 12345): any {
  const proc = new EventEmitter() as any
  proc.stdin = { write: vi.fn(), end: vi.fn() }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.pid = pid
  proc.kill = vi.fn()
  return proc
}

const logs: string[] = []
const onLog = (msg: string) => { logs.push(msg) }

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-agent-test-'))
  logs.length = 0
  _spawnMockImpl = null
  vi.restoreAllMocks()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  _spawnMockImpl = null
  vi.restoreAllMocks()
})

// ── getTopTask: task priority selection ───────────────────────────────────────

import { getTopTask } from './scanner.js'

describe('getTopTask', () => {
  it('prefers active tasks over ready tasks', () => {
    const activeTask = makeTask({ status: 'in_progress', title: 'Active task' })
    const readyTask = makeTask({ status: 'ready', title: 'Ready task' })
    const project: AahpProject = {
      name: 'test',
      repoPath: '/tmp/test',
      handoffDir: '/tmp/test/.ai/handoff',
      manifest: makeManifest(),
      readyTasks: [['T-002', readyTask]],
      activeTasks: [['T-001', activeTask]],
      blockedTasks: [],
      cancelledTasks: [],
      doneTasks: [],
    }
    const top = getTopTask(project)
    expect(top).toBeDefined()
    expect(top![0]).toBe('T-001')
    expect(top![1].title).toBe('Active task')
  })

  it('falls back to ready tasks when no active tasks', () => {
    const readyTask = makeTask({ status: 'ready', title: 'Ready task' })
    const project: AahpProject = {
      name: 'test',
      repoPath: '/tmp/test',
      handoffDir: '/tmp/test/.ai/handoff',
      manifest: makeManifest(),
      readyTasks: [['T-001', readyTask]],
      activeTasks: [],
      blockedTasks: [],
      cancelledTasks: [],
      doneTasks: [],
    }
    const top = getTopTask(project)
    expect(top).toBeDefined()
    expect(top![0]).toBe('T-001')
  })

  it('returns blocked tasks as last resort', () => {
    const blockedTask = makeTask({ status: 'blocked', title: 'Blocked task' })
    const project: AahpProject = {
      name: 'test',
      repoPath: '/tmp/test',
      handoffDir: '/tmp/test/.ai/handoff',
      manifest: makeManifest(),
      readyTasks: [],
      activeTasks: [],
      blockedTasks: [['T-001', blockedTask]],
      cancelledTasks: [],
      doneTasks: [],
    }
    const top = getTopTask(project)
    expect(top).toBeDefined()
    expect(top![0]).toBe('T-001')
    expect(top![1].status).toBe('blocked')
  })

  it('returns undefined when no actionable tasks exist', () => {
    const project: AahpProject = {
      name: 'test',
      repoPath: '/tmp/test',
      handoffDir: '/tmp/test/.ai/handoff',
      manifest: makeManifest(),
      readyTasks: [],
      activeTasks: [],
      blockedTasks: [],
      cancelledTasks: [],
      doneTasks: [],
    }
    expect(getTopTask(project)).toBeUndefined()
  })
})

// ── LOG.md result logging (writeLog / agentLogPath) ───────────────────────────

import { agentLogPath, writeLog } from './status-board.js'

describe('agentLogPath and writeLog', () => {
  it('writes log to repo .ai/logs directory', () => {
    const repoPath = makeTmpRepo('log-test-repo')
    const logFile = agentLogPath('log-test-repo', repoPath)
    expect(logFile).toContain(path.join(repoPath, '.ai', 'logs'))
    expect(fs.existsSync(path.dirname(logFile))).toBe(true)
  })

  it('falls back to home .aahp/logs when no repoPath given', () => {
    const logFile = agentLogPath('some-agent-repo')
    expect(logFile).toContain('.aahp')
  })

  it('writeLog appends text to the log file', () => {
    const repoPath = makeTmpRepo('writeLog-test-repo')
    const logFile = agentLogPath('writeLog-test-repo', repoPath)
    writeLog(logFile, 'first line\n')
    writeLog(logFile, 'second line\n')
    const content = fs.readFileSync(logFile, 'utf8')
    expect(content).toContain('first line')
    expect(content).toContain('second line')
  })

  it('writeLog creates the log file if it does not exist', () => {
    const repoPath = makeTmpRepo('new-log-repo')
    const customLog = path.join(repoPath, '.ai', 'logs', 'custom.log')
    fs.mkdirSync(path.dirname(customLog), { recursive: true })
    writeLog(customLog, 'hello\n')
    expect(fs.existsSync(customLog)).toBe(true)
    expect(fs.readFileSync(customLog, 'utf8')).toBe('hello\n')
  })
})

// ── MANIFEST task selection from NEXT_ACTIONS ─────────────────────────────────

import { syncNextActionsToManifest } from './scanner.js'

describe('syncNextActionsToManifest', () => {
  it('imports ready tasks from NEXT_ACTIONS.md into manifest', () => {
    const repoPath = makeTmpRepo('na-test-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const nextActions = `# NEXT_ACTIONS

## ⚡ Ready - Work These Next

### T-001: Implement search feature
- **Goal:** Add full-text search to the API
- **What to do:** Create search endpoint

### T-002: Add caching layer
- **Goal:** Reduce database load
`
    fs.writeFileSync(path.join(handoffDir, 'NEXT_ACTIONS.md'), nextActions)

    const manifest = makeManifest({ tasks: {} })
    const updated = syncNextActionsToManifest(repoPath, handoffDir, manifest)

    const tasks = updated.tasks ?? {}
    const titles = Object.values(tasks).map(t => t.title)
    expect(titles.some(t => t.toLowerCase().includes('search'))).toBe(true)
  })

  it('does not import done tasks from NEXT_ACTIONS.md', () => {
    const repoPath = makeTmpRepo('na-done-test-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const nextActions = `# NEXT_ACTIONS

## ✅ Recently Completed

### T-001: Old done task
- this is done
`
    fs.writeFileSync(path.join(handoffDir, 'NEXT_ACTIONS.md'), nextActions)

    const manifest = makeManifest({ tasks: {} })
    const updated = syncNextActionsToManifest(repoPath, handoffDir, manifest)
    const tasks = updated.tasks ?? {}
    expect(Object.keys(tasks)).toHaveLength(0)
  })

  it('skips import when NEXT_ACTIONS.md is missing', () => {
    const repoPath = makeTmpRepo('na-missing-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const manifest = makeManifest({ tasks: { 'T-001': makeTask() } })
    const updated = syncNextActionsToManifest(repoPath, handoffDir, manifest)
    expect(Object.keys(updated.tasks ?? {})).toHaveLength(1)
  })

  it('does not create duplicate tasks for the same title', () => {
    const repoPath = makeTmpRepo('na-dedup-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const nextActions = `# NEXT_ACTIONS

## ⚡ Ready - Work These Next

### T-005: Implement search feature
- **Goal:** Add search
`
    fs.writeFileSync(path.join(handoffDir, 'NEXT_ACTIONS.md'), nextActions)

    // Pre-existing task with same title
    const manifest = makeManifest({
      tasks: { 'T-005': makeTask({ title: 'Implement search feature', status: 'ready' }) },
    })
    const updated = syncNextActionsToManifest(repoPath, handoffDir, manifest)
    expect(Object.keys(updated.tasks ?? {})).toHaveLength(1)
  })
})

// ── saveManifest / task-done persistence ──────────────────────────────────────

import { saveManifest } from './scanner.js'

describe('saveManifest', () => {
  it('writes manifest JSON to the handoff directory', () => {
    const repoPath = makeTmpRepo('save-manifest-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const project = makeProject(repoPath, { handoffDir })
    const updatedManifest = makeManifest({
      tasks: { 'T-001': makeTask({ status: 'done', completed: new Date().toISOString() }) },
    })
    saveManifest(project, updatedManifest)

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(handoffDir, 'MANIFEST.json'), 'utf8')
    ) as AahpManifest
    expect(onDisk.tasks?.['T-001']?.status).toBe('done')
    expect(onDisk.tasks?.['T-001']?.completed).toBeDefined()
  })

  it('serializes nested task fields correctly', () => {
    const repoPath = makeTmpRepo('save-manifest-fields-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const project = makeProject(repoPath, { handoffDir })
    const task: AahpTask = {
      title: 'Add test coverage',
      status: 'done',
      priority: 'high',
      depends_on: ['T-000'],
      created: '2026-01-01T00:00:00Z',
      completed: '2026-03-19T05:00:00Z',
      notes: 'Needs mocks',
      github_issue: 42,
      github_repo: 'homeofe/aahp-runner',
    }
    const manifest = makeManifest({ tasks: { 'T-007': task } })
    saveManifest(project, manifest)

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(handoffDir, 'MANIFEST.json'), 'utf8')
    ) as AahpManifest
    const saved = onDisk.tasks?.['T-007']
    expect(saved?.priority).toBe('high')
    expect(saved?.depends_on).toEqual(['T-000'])
    expect(saved?.github_issue).toBe(42)
    expect(saved?.github_repo).toBe('homeofe/aahp-runner')
  })
})

// ── runAgent: backend = 'none' throws descriptive error ───────────────────────

import { runAgent } from './agent.js'
import * as tools from './tools.js'

describe('runAgent - backend none', () => {
  it('throws a descriptive error when no backend is available', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: 'not found', code: 1 }
      if (args?.includes('token')) return { stdout: '', stderr: '', code: 1 }
      return { stdout: '', stderr: '', code: 1 }
    })

    const repoPath = makeTmpRepo('no-backend-repo')
    const project = makeProject(repoPath)
    const task = makeTask()

    await expect(
      runAgent(project, 'T-001', task, '', onLog, 'auto', 1)
    ).rejects.toThrow(/No agent backend|Claude Code|gh auth/)
  })

  it('throws specific error when explicit "claude" backend not found', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async () => ({
      stdout: '', stderr: 'not found', code: 1,
    }))

    const repoPath = makeTmpRepo('no-claude-repo')
    const project = makeProject(repoPath)
    const task = makeTask()

    await expect(
      runAgent(project, 'T-001', task, '', onLog, 'claude', 1)
    ).rejects.toThrow(/Claude Code CLI not found/)
  })

  it('throws specific error when explicit "copilot" backend not found', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async () => ({
      stdout: '', stderr: '', code: 1,
    }))

    const repoPath = makeTmpRepo('no-copilot-repo')
    const project = makeProject(repoPath)
    const task = makeTask()

    await expect(
      runAgent(project, 'T-001', task, '', onLog, 'copilot', 1)
    ).rejects.toThrow(/GitHub Copilot token not found/)
  })
})

// ── runAgent: SDK backend (mocked Anthropic client) ───────────────────────────

describe('runAgent - sdk backend', () => {
  it('completes task and marks it done when git_commit tool is called', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('rev-parse')) return { stdout: 'abc1234567890\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'I will implement the task.' },
          { type: 'tool_use', id: 'tool1', name: 'git_commit', input: { message: 'feat: implement task' } },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Task completed and committed.' }],
        stop_reason: 'end_turn',
      })

    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = { create: mockCreate }
      },
    }))

    vi.spyOn(tools, 'executeTool').mockImplementation(async (name: string) => {
      if (name === 'git_commit') return 'OK: committed abc1234'
      return 'OK: done'
    })

    const repoPath = makeTmpRepo('sdk-test-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({
      tasks: { 'T-001': makeTask({ title: 'Implement feature X' }) },
    }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask({ title: 'Implement feature X' })

    const result = await runAgent(project, 'T-001', task, 'sk-ant-fake-key', onLog, 'sdk', 1)

    expect(result.taskId).toBe('T-001')
    expect(result.committed).toBe(true)
    expect(result.success).toBe(true)
    expect(result.logFile).toBeTruthy()
    expect(fs.existsSync(result.logFile)).toBe(true)
  })

  it('returns success=false when no commit happens (end_turn without git_commit)', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockCreate = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I analyzed the code but could not complete the task.' }],
      stop_reason: 'end_turn',
    })

    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = { create: mockCreate }
      },
    }))

    vi.spyOn(tools, 'executeTool').mockResolvedValue('OK: done')

    const repoPath = makeTmpRepo('sdk-no-commit-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask() } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask()

    const result = await runAgent(project, 'T-001', task, 'sk-ant-fake-key', onLog, 'sdk', 1)

    expect(result.committed).toBe(false)
    expect(result.success).toBe(false)
  })

  it('logs task start and backend info to onLog', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockCreate = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
    })

    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = { create: mockCreate }
      },
    }))

    vi.spyOn(tools, 'executeTool').mockResolvedValue('OK')

    const repoPath = makeTmpRepo('sdk-log-test-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask({ title: 'Log test task' }) } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask({ title: 'Log test task' })

    await runAgent(project, 'T-001', task, 'sk-ant-fake-key', onLog, 'sdk', 1)

    const logMessages = logs.join('\n')
    expect(logMessages).toContain('T-001')
    expect(logMessages).toContain('Log test task')
    // The SDK backend logs "Anthropic SDK (API key)"
    expect(logMessages).toContain('Anthropic SDK')
  })

  it('writes start/end markers to the log file', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Done.' }],
            stop_reason: 'end_turn',
          }),
        }
      },
    }))

    vi.spyOn(tools, 'executeTool').mockResolvedValue('OK')

    const repoPath = makeTmpRepo('sdk-logfile-test-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask({ title: 'Logfile test' }) } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask({ title: 'Logfile test' })

    const result = await runAgent(project, 'T-001', task, 'sk-ant-fake-key', onLog, 'sdk', 1)

    expect(fs.existsSync(result.logFile)).toBe(true)
    const logContent = fs.readFileSync(result.logFile, 'utf8')
    expect(logContent).toContain('AAHP START')
    expect(logContent).toContain('T-001')
    // End marker: DONE or FAILED
    expect(logContent).toMatch(/AAHP (DONE|FAILED)/)
  })
})

// ── runAgent: claude-cli backend (mocked spawn) ───────────────────────────────

describe('runAgent - claude-cli backend', () => {
  it('detects commit by comparing git HEAD before and after', async () => {
    let headCallCount = 0

    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: 'claude 1.0.0\n', stderr: '', code: 0 }
      if (args?.includes('rev-parse')) {
        headCallCount++
        const sha = headCallCount === 1 ? 'before-sha-abc123\n' : 'after-sha-def456\n'
        return { stdout: sha, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockProc = makeMockProc(12345)
    _spawnMockImpl = () => mockProc

    const { ResourceMonitor } = await import('./resource-monitor.js')
    vi.spyOn(ResourceMonitor.prototype, 'start').mockReturnValue(undefined)
    vi.spyOn(ResourceMonitor.prototype, 'stop').mockReturnValue(undefined)
    vi.spyOn(ResourceMonitor.prototype, 'avgCpu').mockReturnValue(5.0)
    vi.spyOn(ResourceMonitor.prototype, 'peakMemMB').mockReturnValue(120)

    const repoPath = makeTmpRepo('claude-cli-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask({ title: 'CLI test task' }) } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask({ title: 'CLI test task' })

    const resultPromise = runAgent(project, 'T-001', task, '', onLog, 'claude', 1)

    setImmediate(() => {
      mockProc.stdout.emit('data', Buffer.from('Task complete! Committed changes.\n'))
      mockProc.emit('close', 0)
    })

    const result = await resultPromise

    expect(result.taskId).toBe('T-001')
    // HEAD changed → committed = true
    expect(result.committed).toBe(true)
    expect(result.cpuAvg).toBe(5.0)
    expect(result.memPeakMB).toBe(120)
  })

  it('returns committed=false when HEAD does not change', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: 'claude 1.0.0\n', stderr: '', code: 0 }
      // Same SHA both calls → no commit
      if (args?.includes('rev-parse')) return { stdout: 'same-sha-abc123\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockProc = makeMockProc(12346)
    _spawnMockImpl = () => mockProc

    const { ResourceMonitor } = await import('./resource-monitor.js')
    vi.spyOn(ResourceMonitor.prototype, 'start').mockReturnValue(undefined)
    vi.spyOn(ResourceMonitor.prototype, 'stop').mockReturnValue(undefined)
    vi.spyOn(ResourceMonitor.prototype, 'avgCpu').mockReturnValue(0)
    vi.spyOn(ResourceMonitor.prototype, 'peakMemMB').mockReturnValue(0)

    const repoPath = makeTmpRepo('claude-cli-no-commit-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask() } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask()

    const resultPromise = runAgent(project, 'T-001', task, '', onLog, 'claude', 1)

    setImmediate(() => {
      mockProc.stdout.emit('data', Buffer.from('Analyzed code but nothing to commit.\n'))
      mockProc.emit('close', 0)
    })

    const result = await resultPromise
    expect(result.committed).toBe(false)
    expect(result.success).toBe(false)
  })

  it('handles spawn error gracefully', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: 'claude 1.0.0\n', stderr: '', code: 0 }
      if (args?.includes('rev-parse')) return { stdout: 'same-sha\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockProc = makeMockProc(undefined)
    _spawnMockImpl = () => mockProc

    const repoPath = makeTmpRepo('claude-cli-error-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask() } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask()

    const resultPromise = runAgent(project, 'T-001', task, '', onLog, 'claude', 1)

    setImmediate(() => {
      mockProc.emit('error', new Error('spawn ENOENT'))
    })

    const result = await resultPromise
    expect(result.success).toBe(false)
    const logMessages = logs.join('\n')
    expect(logMessages).toContain('spawn error')
  })

  it('streams stdout output to onLog in real-time', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: 'claude 1.0.0\n', stderr: '', code: 0 }
      if (args?.includes('rev-parse')) return { stdout: 'same-sha-123\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockProc = makeMockProc(12347)
    _spawnMockImpl = () => mockProc

    const { ResourceMonitor } = await import('./resource-monitor.js')
    vi.spyOn(ResourceMonitor.prototype, 'start').mockReturnValue(undefined)
    vi.spyOn(ResourceMonitor.prototype, 'stop').mockReturnValue(undefined)
    vi.spyOn(ResourceMonitor.prototype, 'avgCpu').mockReturnValue(0)
    vi.spyOn(ResourceMonitor.prototype, 'peakMemMB').mockReturnValue(0)

    const repoPath = makeTmpRepo('claude-cli-stream-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask({ title: 'Stream test' }) } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask({ title: 'Stream test' })

    const resultPromise = runAgent(project, 'T-001', task, '', onLog, 'claude', 1)

    setImmediate(() => {
      mockProc.stdout.emit('data', Buffer.from('Reading files...\n'))
      mockProc.stdout.emit('data', Buffer.from('Writing changes...\n'))
      mockProc.emit('close', 0)
    })

    await resultPromise

    const logMessages = logs.join('\n')
    expect(logMessages).toContain('Reading files...')
    expect(logMessages).toContain('Writing changes...')
  })
})

// ── runAgent: copilot backend (mocked fetch) ──────────────────────────────────

describe('runAgent - copilot backend', () => {
  it('handles 401 Copilot error by throwing a clear auth error', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: 'gho_fake_token\n', stderr: '', code: 0 }
      if (args?.includes('rev-parse')) return { stdout: 'abc-sha\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })
    vi.stubGlobal('fetch', mockFetch)

    const repoPath = makeTmpRepo('copilot-401-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask() } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask()

    await expect(
      runAgent(project, 'T-001', task, '', onLog, 'copilot', 1)
    ).rejects.toThrow(/GitHub Copilot token invalid|expired/)

    vi.unstubAllGlobals()
  })

  it('handles non-401 API error by returning failure result', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: 'gho_fake_token\n', stderr: '', code: 0 }
      if (args?.includes('rev-parse')) return { stdout: 'abc-sha\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    })
    vi.stubGlobal('fetch', mockFetch)

    const repoPath = makeTmpRepo('copilot-503-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask() } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask()

    const result = await runAgent(project, 'T-001', task, '', onLog, 'copilot', 1)
    expect(result.success).toBe(false)
    expect(result.committed).toBe(false)

    vi.unstubAllGlobals()
  })

  it('handles network errors gracefully without throwing', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: 'gho_fake_token\n', stderr: '', code: 0 }
      if (args?.includes('rev-parse')) return { stdout: 'abc-sha\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const mockFetch = vi.fn().mockRejectedValue(new TypeError('network error'))
    vi.stubGlobal('fetch', mockFetch)

    const repoPath = makeTmpRepo('copilot-network-error-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask() } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask()

    const result = await runAgent(project, 'T-001', task, '', onLog, 'copilot', 1)
    expect(result.success).toBe(false)
    expect(result.committed).toBe(false)

    vi.unstubAllGlobals()
  })

  it('marks task done and updates MANIFEST.json on successful git_commit', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: 'gho_fake_token\n', stderr: '', code: 0 }
      if (args?.includes('rev-parse')) return { stdout: 'abc-sha\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    vi.spyOn(tools, 'executeTool').mockImplementation(async (name: string) => {
      if (name === 'git_commit') return 'OK: committed abc123'
      return 'OK'
    })

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: 'I will commit the changes.',
              tool_calls: [{
                id: 'call_1',
                function: {
                  name: 'git_commit',
                  arguments: JSON.stringify({ message: 'feat: implement T-001' }),
                },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            finish_reason: 'stop',
            message: { content: 'Task complete!', tool_calls: [] },
          }],
        }),
      })

    vi.stubGlobal('fetch', mockFetch)

    const repoPath = makeTmpRepo('copilot-success-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({
      tasks: { 'T-001': makeTask({ title: 'Copilot success task' }) },
    }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask({ title: 'Copilot success task' })

    const result = await runAgent(project, 'T-001', task, '', onLog, 'copilot', 1)

    expect(result.committed).toBe(true)
    expect(result.success).toBe(true)

    // MANIFEST.json should have T-001 as done
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(handoffDir, 'MANIFEST.json'), 'utf8')
    ) as AahpManifest
    expect(onDisk.tasks?.['T-001']?.status).toBe('done')

    vi.unstubAllGlobals()
  })
})

// ── AgentResult shape validation ──────────────────────────────────────────────

describe('AgentResult structure', () => {
  it('result always contains all required fields with correct types', async () => {
    vi.spyOn(tools, 'runAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args?.includes('--version')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('token')) return { stdout: '', stderr: '', code: 1 }
      if (args?.includes('rev-parse')) return { stdout: 'sha\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Done.' }],
            stop_reason: 'end_turn',
          }),
        }
      },
    }))

    vi.spyOn(tools, 'executeTool').mockResolvedValue('OK')

    const repoPath = makeTmpRepo('result-shape-repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    writeManifest(repoPath, makeManifest({ tasks: { 'T-001': makeTask() } }))

    const project = makeProject(repoPath, { handoffDir })
    const task = makeTask()

    const result = await runAgent(project, 'T-001', task, 'sk-ant-key', onLog, 'sdk', 1)

    expect(typeof result.success).toBe('boolean')
    expect(typeof result.taskId).toBe('string')
    expect(typeof result.turns).toBe('number')
    expect(typeof result.committed).toBe('boolean')
    expect(typeof result.summary).toBe('string')
    expect(typeof result.logFile).toBe('string')
    expect(result.taskId).toBe('T-001')
    expect(result.turns).toBeGreaterThanOrEqual(1)
  })
})
