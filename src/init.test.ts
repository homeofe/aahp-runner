import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initProject } from './init.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-init-test-'))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

const EXPECTED_FILES = [
  'MANIFEST.json',
  'STATUS.md',
  'NEXT_ACTIONS.md',
  'LOG.md',
  'LOG-ARCHIVE.md',
  'DASHBOARD.md',
  'CONVENTIONS.md',
  'TRUST.md',
  'WORKFLOW.md',
  '.aiignore',
]

// ── tests ─────────────────────────────────────────────────────────────────────

describe('initProject', () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = makeTmpDir() })
  afterEach(() => { cleanup(tmpDir) })

  it('creates .ai/handoff/ directory', () => {
    initProject(tmpDir, false)
    expect(fs.existsSync(path.join(tmpDir, '.ai', 'handoff'))).toBe(true)
  })

  it('creates .ai/handoff/logs/ directory', () => {
    initProject(tmpDir, false)
    expect(fs.existsSync(path.join(tmpDir, '.ai', 'handoff', 'logs'))).toBe(true)
  })

  it('creates all 10 template files', () => {
    const result = initProject(tmpDir, false)
    expect(result.created).toHaveLength(EXPECTED_FILES.length)
    for (const f of EXPECTED_FILES) {
      expect(fs.existsSync(path.join(tmpDir, '.ai', 'handoff', f))).toBe(true)
    }
  })

  it('returns the correct projectName from directory basename', () => {
    const result = initProject(tmpDir, false)
    expect(result.projectName).toBe(path.basename(tmpDir))
  })

  it('reads project name from package.json if present', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-cool-app' }))
    const result = initProject(tmpDir, false)
    expect(result.projectName).toBe('my-cool-app')
  })

  it('strips npm scope from package.json name', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: '@myorg/my-cool-app' }))
    const result = initProject(tmpDir, false)
    expect(result.projectName).toBe('my-cool-app')
  })

  it('substitutes project name in STATUS.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }))
    initProject(tmpDir, false)
    const status = fs.readFileSync(path.join(tmpDir, '.ai', 'handoff', 'STATUS.md'), 'utf8')
    expect(status).toContain('test-project')
  })

  it('substitutes project name in MANIFEST.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }))
    initProject(tmpDir, false)
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, '.ai', 'handoff', 'MANIFEST.json'), 'utf8'))
    expect(manifest.project).toBe('test-project')
  })

  it('MANIFEST.json has valid structure', () => {
    initProject(tmpDir, false)
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, '.ai', 'handoff', 'MANIFEST.json'), 'utf8'))
    expect(manifest.aahp_version).toBe('3.0')
    expect(manifest.next_task_id).toBe(1)
    expect(manifest.tasks).toEqual({})
    expect(manifest.last_session.phase).toBe('setup')
  })

  it('skips existing files when force=false', () => {
    // Create one file manually
    fs.mkdirSync(path.join(tmpDir, '.ai', 'handoff'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.ai', 'handoff', 'MANIFEST.json'), '{"existing":true}')

    const result = initProject(tmpDir, false)
    expect(result.skipped).toContain('MANIFEST.json')
    expect(result.created).not.toContain('MANIFEST.json')

    // Pre-existing content is preserved
    const content = fs.readFileSync(path.join(tmpDir, '.ai', 'handoff', 'MANIFEST.json'), 'utf8')
    expect(JSON.parse(content)).toEqual({ existing: true })
  })

  it('overwrites existing files when force=true', () => {
    fs.mkdirSync(path.join(tmpDir, '.ai', 'handoff'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.ai', 'handoff', 'MANIFEST.json'), '{"existing":true}')

    const result = initProject(tmpDir, true)
    expect(result.created).toContain('MANIFEST.json')
    expect(result.skipped).not.toContain('MANIFEST.json')

    const content = fs.readFileSync(path.join(tmpDir, '.ai', 'handoff', 'MANIFEST.json'), 'utf8')
    const manifest = JSON.parse(content)
    expect(manifest.aahp_version).toBe('3.0')
  })

  it('adds .ai/logs/ to .gitignore', () => {
    initProject(tmpDir, false)
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.ai/logs/')
  })

  it('appends to existing .gitignore without duplicating', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n')
    initProject(tmpDir, false)
    initProject(tmpDir, false) // run twice

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')
    expect(gitignore).toContain('node_modules/')
    expect(gitignore).toContain('.ai/logs/')
    // Should not be duplicated
    const count = (gitignore.match(/\.ai\/logs\//g) ?? []).length
    expect(count).toBe(1)
  })

  it('.aiignore contains security patterns', () => {
    initProject(tmpDir, false)
    const aiignore = fs.readFileSync(path.join(tmpDir, '.ai', 'handoff', '.aiignore'), 'utf8')
    expect(aiignore).toContain('sk-ant-*')
    expect(aiignore).toContain('Bearer *')
    expect(aiignore).toContain('ignore all previous*')
  })

  it('CONVENTIONS.md contains Three Laws', () => {
    initProject(tmpDir, false)
    const conv = fs.readFileSync(path.join(tmpDir, '.ai', 'handoff', 'CONVENTIONS.md'), 'utf8')
    expect(conv).toContain('First Law')
    expect(conv).toContain('Second Law')
    expect(conv).toContain('Third Law')
  })

  it('returns handoffDir path', () => {
    const result = initProject(tmpDir, false)
    expect(result.handoffDir).toBe(path.join(tmpDir, '.ai', 'handoff'))
  })
})
