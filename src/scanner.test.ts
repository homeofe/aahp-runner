import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { scanProjects, getTopTask, readHandoffFile, buildSystemPrompt, saveManifest } from './scanner.js'
import type { AahpManifest, AahpProject, AahpTask } from './types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-test-'))
}

function writeManifest(repoName: string, manifest: AahpManifest): void {
  const handoffDir = path.join(tmpDir, repoName, '.ai', 'handoff')
  fs.mkdirSync(handoffDir, { recursive: true })
  fs.writeFileSync(
    path.join(handoffDir, 'MANIFEST.json'),
    JSON.stringify(manifest, null, 2),
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
    quick_context: 'A test project',
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

function makeProject(overrides: Partial<AahpProject> = {}): AahpProject {
  return {
    name: 'test-project',
    repoPath: '/tmp/test-project',
    handoffDir: '/tmp/test-project/.ai/handoff',
    manifest: makeManifest(),
    readyTasks: [],
    activeTasks: [],
    blockedTasks: [],
    cancelledTasks: [],
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = makeTmpDir()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── scanProjects ─────────────────────────────────────────────────────────────

describe('scanProjects', () => {
  it('returns empty array for empty directory', () => {
    const projects = scanProjects(tmpDir)
    expect(projects).toEqual([])
  })

  it('returns empty array for non-existent directory', () => {
    const projects = scanProjects(path.join(tmpDir, 'nonexistent'))
    expect(projects).toEqual([])
  })

  it('discovers a project with MANIFEST.json', () => {
    const manifest = makeManifest({ project: 'my-app' })
    writeManifest('my-app', manifest)

    const projects = scanProjects(tmpDir)
    expect(projects).toHaveLength(1)
    expect(projects[0]!.name).toBe('my-app')
    expect(projects[0]!.repoPath).toBe(path.join(tmpDir, 'my-app'))
  })

  it('ignores directories without MANIFEST.json', () => {
    fs.mkdirSync(path.join(tmpDir, 'no-handoff'), { recursive: true })
    writeManifest('has-handoff', makeManifest({ project: 'has-handoff' }))

    const projects = scanProjects(tmpDir)
    expect(projects).toHaveLength(1)
    expect(projects[0]!.name).toBe('has-handoff')
  })

  it('ignores files (non-directories) in root', () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hello')
    const projects = scanProjects(tmpDir)
    expect(projects).toEqual([])
  })

  it('skips projects with malformed MANIFEST.json', () => {
    const handoffDir = path.join(tmpDir, 'broken', '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, 'MANIFEST.json'), '{bad json')

    const projects = scanProjects(tmpDir)
    expect(projects).toEqual([])
  })

  it('separates ready and in_progress tasks', () => {
    const manifest = makeManifest({
      project: 'multi-task',
      tasks: {
        'T-001': makeTask({ title: 'Ready one', status: 'ready' }),
        'T-002': makeTask({ title: 'Active one', status: 'in_progress' }),
        'T-003': makeTask({ title: 'Done one', status: 'done' }),
        'T-004': makeTask({ title: 'Ready two', status: 'ready' }),
      },
    })
    writeManifest('multi-task', manifest)

    const projects = scanProjects(tmpDir)
    expect(projects).toHaveLength(1)
    expect(projects[0]!.readyTasks).toHaveLength(2)
    expect(projects[0]!.activeTasks).toHaveLength(1)
  })

  it('sorts projects by activity (active tasks first)', () => {
    writeManifest('idle-project', makeManifest({
      project: 'idle-project',
      tasks: {
        'T-001': makeTask({ status: 'done' }),
      },
    }))
    writeManifest('active-project', makeManifest({
      project: 'active-project',
      tasks: {
        'T-001': makeTask({ status: 'in_progress' }),
        'T-002': makeTask({ status: 'ready' }),
      },
    }))
    writeManifest('ready-project', makeManifest({
      project: 'ready-project',
      tasks: {
        'T-001': makeTask({ status: 'ready' }),
      },
    }))

    const projects = scanProjects(tmpDir)
    expect(projects[0]!.name).toBe('active-project')
    expect(projects[1]!.name).toBe('ready-project')
    expect(projects[2]!.name).toBe('idle-project')
  })

  it('uses directory name when manifest.project is empty', () => {
    const manifest = makeManifest({ project: '' })
    writeManifest('dir-name-repo', manifest)

    const projects = scanProjects(tmpDir)
    expect(projects[0]!.name).toBe('dir-name-repo')
  })
})

// ── getTopTask ───────────────────────────────────────────────────────────────

describe('getTopTask', () => {
  it('returns undefined when no tasks exist', () => {
    const project = makeProject()
    expect(getTopTask(project)).toBeUndefined()
  })

  it('returns active task over ready task', () => {
    const activeTask = makeTask({ title: 'Active', status: 'in_progress' })
    const readyTask = makeTask({ title: 'Ready', status: 'ready' })
    const project = makeProject({
      activeTasks: [['T-001', activeTask]],
      readyTasks: [['T-002', readyTask]],
    })

    const top = getTopTask(project)
    expect(top).toBeDefined()
    expect(top![0]).toBe('T-001')
    expect(top![1].title).toBe('Active')
  })

  it('returns first ready task when no active tasks', () => {
    const readyTask = makeTask({ title: 'Ready', status: 'ready' })
    const project = makeProject({
      readyTasks: [['T-001', readyTask]],
    })

    const top = getTopTask(project)
    expect(top).toBeDefined()
    expect(top![0]).toBe('T-001')
  })
})

// ── readHandoffFile ──────────────────────────────────────────────────────────

describe('readHandoffFile', () => {
  it('reads an existing file', () => {
    const handoffDir = path.join(tmpDir, 'repo', '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, 'STATUS.md'), '# Status\nAll good')

    const project = makeProject({
      handoffDir,
    })

    const content = readHandoffFile(project, 'STATUS.md')
    expect(content).toBe('# Status\nAll good')
  })

  it('returns empty string for missing file', () => {
    const handoffDir = path.join(tmpDir, 'repo', '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const project = makeProject({ handoffDir })
    const content = readHandoffFile(project, 'NONEXISTENT.md')
    expect(content).toBe('')
  })
})

// ── buildSystemPrompt ────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('includes project name and task info', () => {
    const manifest = makeManifest({
      project: 'my-project',
      quick_context: 'A great project',
      tasks: {
        'T-001': makeTask({ title: 'Build thing', status: 'ready', priority: 'high' }),
      },
    })
    const handoffDir = path.join(tmpDir, 'repo', '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const project = makeProject({ manifest, handoffDir, name: 'my-project' })
    const task = makeTask({ title: 'Build thing', priority: 'high' })

    const prompt = buildSystemPrompt(project, 'T-001', task)

    expect(prompt).toContain('my-project')
    expect(prompt).toContain('[T-001] Build thing')
    expect(prompt).toContain('Priority: high')
    expect(prompt).toContain('A great project')
    expect(prompt).toContain('autonomous agent')
  })

  it('includes open tasks listing', () => {
    const manifest = makeManifest({
      project: 'proj',
      tasks: {
        'T-001': makeTask({ title: 'Done task', status: 'done' }),
        'T-002': makeTask({ title: 'Ready task', status: 'ready' }),
        'T-003': makeTask({ title: 'Blocked task', status: 'blocked' }),
      },
    })
    const handoffDir = path.join(tmpDir, 'repo', '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const project = makeProject({ manifest, handoffDir })
    const task = makeTask({ title: 'Ready task', status: 'ready' })

    const prompt = buildSystemPrompt(project, 'T-002', task)

    // Done tasks should NOT appear in open tasks
    expect(prompt).not.toContain('T-001')
    expect(prompt).toContain('T-002')
    expect(prompt).toContain('T-003')
  })

  it('includes conventions, trust, and status when files exist', () => {
    const handoffDir = path.join(tmpDir, 'repo', '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, 'CONVENTIONS.md'), 'Use TypeScript')
    fs.writeFileSync(path.join(handoffDir, 'TRUST.md'), 'Build verified')
    fs.writeFileSync(path.join(handoffDir, 'STATUS.md'), 'All green')

    const project = makeProject({
      manifest: makeManifest({ project: 'proj' }),
      handoffDir,
    })
    const task = makeTask()

    const prompt = buildSystemPrompt(project, 'T-001', task)

    expect(prompt).toContain('Use TypeScript')
    expect(prompt).toContain('Build verified')
    expect(prompt).toContain('All green')
  })
})

// ── saveManifest ─────────────────────────────────────────────────────────────

describe('saveManifest', () => {
  it('writes manifest as formatted JSON', () => {
    const handoffDir = path.join(tmpDir, 'repo', '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })

    const manifest = makeManifest({ project: 'saved-project' })
    const project = makeProject({ handoffDir })

    saveManifest(project, manifest)

    const written = fs.readFileSync(path.join(handoffDir, 'MANIFEST.json'), 'utf8')
    expect(written).toContain('"saved-project"')
    // Should be formatted with 2 spaces and trailing newline
    expect(written).toMatch(/^{\n  /)
    expect(written.endsWith('\n')).toBe(true)

    // Should round-trip correctly
    const parsed = JSON.parse(written)
    expect(parsed.project).toBe('saved-project')
  })
})
