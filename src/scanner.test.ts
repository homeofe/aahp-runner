import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ── Mock for child_process (createMissingGitHubIssues shells out to git/gh) ──
// Must be declared before the './scanner.js' import below so the mock is in
// place before scanner.ts's own `import { execFileSync, spawnSync } from
// 'child_process'` resolves.
interface MockCall { cmd: string; args: string[] }
let _execFileSyncMockImpl: ((cmd: string, args: string[]) => string) | null = null
let _spawnSyncMockImpl: ((cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }) | null = null
let _spawnSyncCalls: MockCall[] = []

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], opts?: unknown) => {
      if (_execFileSyncMockImpl) return _execFileSyncMockImpl(cmd, args)
      return actual.execFileSync(cmd, args, opts as never)
    },
    spawnSync: (cmd: string, args: string[], opts?: unknown) => {
      _spawnSyncCalls.push({ cmd, args })
      if (_spawnSyncMockImpl) return _spawnSyncMockImpl(cmd, args)
      return actual.spawnSync(cmd, args, opts as never)
    },
  }
})

import {
  scanProjects, getTopTask, readHandoffFile, buildSystemPrompt, saveManifest,
  validateGitHubRepo, createMissingGitHubIssues, normalizeTitle, titleSimilarity,
} from './scanner.js'
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
  _execFileSyncMockImpl = null
  _spawnSyncMockImpl = null
  _spawnSyncCalls = []
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

// ── validateGitHubRepo (command-injection regression) ────────────────────────

describe('validateGitHubRepo', () => {
  it('accepts a well-formed owner/repo slug', () => {
    expect(validateGitHubRepo('homeofe/aahp-runner')).toBe('homeofe/aahp-runner')
  })

  it('accepts slugs with dots and underscores', () => {
    expect(validateGitHubRepo('my.org/my_repo.js')).toBe('my.org/my_repo.js')
  })

  it('rejects a slug with a shell semicolon', () => {
    expect(validateGitHubRepo('owner/repo;rm -rf /')).toBeNull()
  })

  it('rejects a slug with backtick command substitution', () => {
    expect(validateGitHubRepo('owner/repo`id`')).toBeNull()
  })

  it('rejects a slug with dollar-sign command substitution', () => {
    expect(validateGitHubRepo('owner/repo$(whoami)')).toBeNull()
  })

  it('rejects a slug with pipe metacharacter', () => {
    expect(validateGitHubRepo('owner/repo|cat /etc/passwd')).toBeNull()
  })

  it('rejects a slug with ampersand metacharacter', () => {
    expect(validateGitHubRepo('owner/repo&touch /tmp/pwned')).toBeNull()
  })

  it('rejects a slug missing the slash separator', () => {
    expect(validateGitHubRepo('just-owner')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(validateGitHubRepo('')).toBeNull()
  })

  it('rejects a slug with more than one slash', () => {
    expect(validateGitHubRepo('owner/repo/extra')).toBeNull()
  })

  it('rejects an owner segment starting with a hyphen (flag injection)', () => {
    expect(validateGitHubRepo('-bad/repo')).toBeNull()
  })

  it('rejects a repo segment starting with a hyphen (flag injection)', () => {
    expect(validateGitHubRepo('owner/-bad')).toBeNull()
  })

  it('rejects a crafted slug matching the reported attack vector', () => {
    // Attack: git remote URL contains test$(malicious-command)/repo.git
    expect(validateGitHubRepo('test$(malicious-command)/repo')).toBeNull()
  })
})

// ── normalizeTitle / titleSimilarity (issue #626 regression) ──────────────────
// A bare "#NNN" issue-reference token used to survive normalization and get
// counted as a word, which could depress Jaccard similarity below the 0.85
// dedup threshold for two titles that are otherwise identical.

describe('normalizeTitle', () => {
  it('strips a bare "#NNN" token', () => {
    expect(normalizeTitle('Fix login redirect bug #1010')).toBe('fix login redirect bug')
  })

  it('still strips the existing "(issue #N)" annotation', () => {
    expect(normalizeTitle('Fix login redirect bug (issue #1010)')).toBe('fix login redirect bug')
  })

  it('still strips a leading [T-NNN] prefix', () => {
    expect(normalizeTitle('[T-077] Fix login redirect bug')).toBe('fix login redirect bug')
  })
})

describe('titleSimilarity', () => {
  it('scores two titles as identical once a trailing "#NNN" is normalized away', () => {
    // Before the #626 fix, "1010" survived normalization as its own word, so
    // the two titles below scored 4/5 = 0.8, just under the 0.85 dedup
    // threshold used by both deduplicateGitHubIssues and
    // createMissingGitHubIssues's pre-flight check.
    const similarity = titleSimilarity('Fix login redirect bug #1010', 'Fix login redirect bug')
    expect(similarity).toBe(1)
  })
})

// ── createMissingGitHubIssues (issue #626 regression) ─────────────────────────
// The pre-flight dedup check used to query `gh issue list --state open` only,
// so a task whose matching issue had since been closed was invisible to it and
// a fresh duplicate got filed. It should now see closed issues too and reopen
// the existing one instead of creating a duplicate.

describe('createMissingGitHubIssues', () => {
  function setupRepo(): { repoPath: string; handoffDir: string } {
    const repoPath = path.join(tmpDir, 'repo')
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    fs.mkdirSync(handoffDir, { recursive: true })
    return { repoPath, handoffDir }
  }

  function mockGh(existingIssues: Array<{ number: number; title: string; state: 'OPEN' | 'CLOSED' }>): void {
    _execFileSyncMockImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') return 'https://github.com/homeofe/aahp-runner.git\n'
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return JSON.stringify(existingIssues)
      if (cmd === 'gh' && args[0] === 'label') return ''
      throw new Error(`unexpected execFileSync call in test: ${cmd} ${args.join(' ')}`)
    }
    _spawnSyncMockImpl = (_cmd, args) => {
      if (args[0] === 'issue' && args[1] === 'reopen') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'issue' && args[1] === 'create') {
        return { status: 0, stdout: 'https://github.com/homeofe/aahp-runner/issues/999\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
  }

  it('reopens a closed matching issue instead of filing a duplicate', () => {
    const { repoPath, handoffDir } = setupRepo()
    mockGh([{ number: 42, title: '[T-001] Fix flaky retry test', state: 'CLOSED' }])

    const manifest = makeManifest({
      tasks: { 'T-001': makeTask({ title: 'Fix flaky retry test', status: 'ready' }) },
    })

    const updated = createMissingGitHubIssues(repoPath, handoffDir, manifest)

    expect(updated.tasks!['T-001']!.github_issue).toBe(42)
    const reopenCalls = _spawnSyncCalls.filter(c => c.args[0] === 'issue' && c.args[1] === 'reopen')
    const createCalls = _spawnSyncCalls.filter(c => c.args[0] === 'issue' && c.args[1] === 'create')
    expect(reopenCalls).toHaveLength(1)
    expect(reopenCalls[0]!.args).toContain('42')
    expect(createCalls).toHaveLength(0)
  })

  it('still links to (and does not touch) an open matching issue', () => {
    const { repoPath, handoffDir } = setupRepo()
    mockGh([{ number: 42, title: '[T-001] Fix flaky retry test', state: 'OPEN' }])

    const manifest = makeManifest({
      tasks: { 'T-001': makeTask({ title: 'Fix flaky retry test', status: 'ready' }) },
    })

    const updated = createMissingGitHubIssues(repoPath, handoffDir, manifest)

    expect(updated.tasks!['T-001']!.github_issue).toBe(42)
    expect(_spawnSyncCalls.filter(c => c.args[0] === 'issue' && (c.args[1] === 'reopen' || c.args[1] === 'create'))).toHaveLength(0)
  })

  it('matches an open issue via title fallback even with a stray "#NNN" reference, and does not create a duplicate', () => {
    const { repoPath, handoffDir } = setupRepo()
    // No T-077 tag in the existing issue's title, so this only matches through
    // the title-similarity fallback, not the task-ID shortcut - which is
    // exactly the path the #NNN-stripping fix in normalizeTitle affects.
    mockGh([{ number: 555, title: 'Fix login redirect bug #1010', state: 'OPEN' }])

    const manifest = makeManifest({
      tasks: { 'T-077': makeTask({ title: 'Fix login redirect bug', status: 'ready' }) },
    })

    const updated = createMissingGitHubIssues(repoPath, handoffDir, manifest)

    expect(updated.tasks!['T-077']!.github_issue).toBe(555)
    expect(_spawnSyncCalls.filter(c => c.args[0] === 'issue' && c.args[1] === 'create')).toHaveLength(0)
  })

  it('creates a new issue when no open or closed match exists', () => {
    const { repoPath, handoffDir } = setupRepo()
    mockGh([])

    const manifest = makeManifest({
      tasks: { 'T-002': makeTask({ title: 'Totally unrelated task', status: 'ready' }) },
    })

    const updated = createMissingGitHubIssues(repoPath, handoffDir, manifest)

    expect(updated.tasks!['T-002']!.github_issue).toBe(999)
    const createCalls = _spawnSyncCalls.filter(c => c.args[0] === 'issue' && c.args[1] === 'create')
    expect(createCalls).toHaveLength(1)
  })
})
