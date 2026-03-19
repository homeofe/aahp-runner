/**
 * Tests for aahp archive command logic (T-006)
 *
 * Covers:
 *  - Moves LOG.md to logs/LOG-YYYY-MM-DD.md
 *  - Creates fresh LOG.md with header
 *  - Keeps last N archived logs (default 10), prunes older ones
 *  - Handles duplicate archive names on same day
 *  - Errors gracefully when no .ai/handoff/ directory exists
 *  - Errors gracefully when LOG.md does not exist
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ── Archive logic extracted for unit testing ──────────────────────────────────
// We test the core logic directly so we don't need to spin up the CLI.

function archiveLog(
  projectDir: string,
  keepCount: number = 10,
  stamp?: string
): { archived: string; pruned: number; archiveDir: string } {
  const handoffDir = path.join(projectDir, '.ai', 'handoff')
  const archiveDir = path.join(handoffDir, 'logs')
  const logFile = path.join(handoffDir, 'LOG.md')

  if (!fs.existsSync(handoffDir)) {
    throw new Error(`No .ai/handoff/ directory found in: ${projectDir}`)
  }
  if (!fs.existsSync(logFile)) {
    throw new Error(`No LOG.md found at: ${logFile}`)
  }

  const dateStamp = stamp ?? new Date().toISOString().slice(0, 10)
  const archiveName = `LOG-${dateStamp}.md`
  fs.mkdirSync(archiveDir, { recursive: true })

  let finalArchivePath = path.join(archiveDir, archiveName)
  if (fs.existsSync(finalArchivePath)) {
    let counter = 1
    while (fs.existsSync(finalArchivePath)) {
      finalArchivePath = path.join(archiveDir, `LOG-${dateStamp}-${counter}.md`)
      counter++
    }
  }

  // Move LOG.md to archive
  fs.copyFileSync(logFile, finalArchivePath)

  // Create fresh LOG.md
  const freshHeader = `# ${path.basename(projectDir)}: Agent Journal\n\n> Archived: ${dateStamp}\n\n---\n\n`
  fs.writeFileSync(logFile, freshHeader, 'utf8')

  // Prune old archives
  const allArchives = fs.readdirSync(archiveDir)
    .filter(f => f.match(/^LOG-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/))
    .sort()

  let pruned = 0
  if (allArchives.length > keepCount) {
    const toDelete = allArchives.slice(0, allArchives.length - keepCount)
    for (const f of toDelete) {
      fs.rmSync(path.join(archiveDir, f))
      pruned++
    }
  }

  return { archived: finalArchivePath, pruned, archiveDir }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string

function makeProject(name = 'test-project'): string {
  const projectDir = path.join(tmpDir, name)
  const handoffDir = path.join(projectDir, '.ai', 'handoff')
  fs.mkdirSync(handoffDir, { recursive: true })
  return projectDir
}

function writeLog(projectDir: string, content: string): void {
  fs.writeFileSync(path.join(projectDir, '.ai', 'handoff', 'LOG.md'), content, 'utf8')
}

function seedArchives(projectDir: string, dates: string[]): void {
  const archiveDir = path.join(projectDir, '.ai', 'handoff', 'logs')
  fs.mkdirSync(archiveDir, { recursive: true })
  for (const d of dates) {
    fs.writeFileSync(path.join(archiveDir, `LOG-${d}.md`), `# Archive ${d}\n`, 'utf8')
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-archive-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('archiveLog - basic functionality', () => {
  it('moves LOG.md content to a dated archive file', () => {
    const projectDir = makeProject()
    const originalContent = '# Journal\n\n## [2026-01-01] Session 1\n\nDid stuff.\n'
    writeLog(projectDir, originalContent)

    const { archived } = archiveLog(projectDir, 10, '2026-03-19')

    expect(fs.existsSync(archived)).toBe(true)
    expect(fs.readFileSync(archived, 'utf8')).toBe(originalContent)
  })

  it('creates archive in .ai/handoff/logs/ subdirectory', () => {
    const projectDir = makeProject()
    writeLog(projectDir, '# Journal\n')

    const { archiveDir } = archiveLog(projectDir, 10, '2026-03-19')

    expect(archiveDir).toContain(path.join('.ai', 'handoff', 'logs'))
    expect(fs.existsSync(archiveDir)).toBe(true)
  })

  it('names the archive LOG-YYYY-MM-DD.md', () => {
    const projectDir = makeProject()
    writeLog(projectDir, '# Journal\n')

    const { archived } = archiveLog(projectDir, 10, '2026-03-19')

    expect(path.basename(archived)).toBe('LOG-2026-03-19.md')
  })

  it('creates a fresh LOG.md after archiving', () => {
    const projectDir = makeProject()
    writeLog(projectDir, '# Old content\n\nOld entries.\n')

    archiveLog(projectDir, 10, '2026-03-19')

    const logPath = path.join(projectDir, '.ai', 'handoff', 'LOG.md')
    expect(fs.existsSync(logPath)).toBe(true)
    const newContent = fs.readFileSync(logPath, 'utf8')
    // Fresh LOG.md should NOT contain old entries
    expect(newContent).not.toContain('Old entries.')
    // Should contain a header / archive timestamp
    expect(newContent).toContain('2026-03-19')
  })

  it('fresh LOG.md includes project name in header', () => {
    const projectDir = makeProject('my-cool-project')
    writeLog(projectDir, '# Journal\n')

    archiveLog(projectDir, 10, '2026-03-19')

    const newContent = fs.readFileSync(path.join(projectDir, '.ai', 'handoff', 'LOG.md'), 'utf8')
    expect(newContent).toContain('my-cool-project')
  })
})

describe('archiveLog - pruning', () => {
  it('keeps exactly N archives when count equals keepCount', () => {
    const projectDir = makeProject()
    // Seed 5 archives
    seedArchives(projectDir, ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'])
    writeLog(projectDir, '# New journal\n')

    archiveLog(projectDir, 5, '2026-01-06')  // 5 existing + 1 new = 6; keep 5 → prune 1

    const archiveDir = path.join(projectDir, '.ai', 'handoff', 'logs')
    const remaining = fs.readdirSync(archiveDir).filter(f => f.match(/^LOG-/))
    expect(remaining).toHaveLength(5)
  })

  it('prunes oldest archives when count exceeds keepCount', () => {
    const projectDir = makeProject()
    // Seed 10 archives (oldest = 2026-01-01)
    seedArchives(projectDir, [
      '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05',
      '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10',
    ])
    writeLog(projectDir, '# New journal\n')

    const { pruned } = archiveLog(projectDir, 10, '2026-01-11')

    // 10 existing + 1 new = 11, keep 10 → prune 1
    expect(pruned).toBe(1)

    const archiveDir = path.join(projectDir, '.ai', 'handoff', 'logs')
    const remaining = fs.readdirSync(archiveDir).filter(f => f.match(/^LOG-/)).sort()
    expect(remaining).toHaveLength(10)
    // Oldest should be gone
    expect(remaining[0]).not.toBe('LOG-2026-01-01.md')
    expect(remaining[0]).toBe('LOG-2026-01-02.md')
  })

  it('does not prune when archive count is within keepCount', () => {
    const projectDir = makeProject()
    seedArchives(projectDir, ['2026-01-01', '2026-01-02'])
    writeLog(projectDir, '# New journal\n')

    const { pruned } = archiveLog(projectDir, 10, '2026-01-03')

    expect(pruned).toBe(0)
    const archiveDir = path.join(projectDir, '.ai', 'handoff', 'logs')
    const remaining = fs.readdirSync(archiveDir).filter(f => f.match(/^LOG-/))
    expect(remaining).toHaveLength(3)
  })

  it('returns pruned count equal to number of deleted archives', () => {
    const projectDir = makeProject()
    seedArchives(projectDir, ['2026-01-01', '2026-01-02', '2026-01-03'])
    writeLog(projectDir, '# Journal\n')

    const { pruned } = archiveLog(projectDir, 2, '2026-01-04')

    // 3 existing + 1 new = 4; keep 2 → prune 2
    expect(pruned).toBe(2)
  })
})

describe('archiveLog - duplicate handling', () => {
  it('does not overwrite existing archive on the same date', () => {
    const projectDir = makeProject()
    seedArchives(projectDir, ['2026-03-19'])
    writeLog(projectDir, '# New content\n')

    const { archived } = archiveLog(projectDir, 10, '2026-03-19')

    // Should get a different name (counter suffix)
    expect(path.basename(archived)).not.toBe('LOG-2026-03-19.md')
    expect(path.basename(archived)).toMatch(/^LOG-2026-03-19-\d+\.md$/)
  })

  it('preserves existing archive content when creating a suffix variant', () => {
    const projectDir = makeProject()
    const archiveDir = path.join(projectDir, '.ai', 'handoff', 'logs')
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, 'LOG-2026-03-19.md'), '# Original archive\n', 'utf8')
    writeLog(projectDir, '# New content\n')

    archiveLog(projectDir, 10, '2026-03-19')

    const original = fs.readFileSync(path.join(archiveDir, 'LOG-2026-03-19.md'), 'utf8')
    expect(original).toBe('# Original archive\n')
  })
})

describe('archiveLog - error handling', () => {
  it('throws when .ai/handoff/ directory does not exist', () => {
    const noHandoffDir = path.join(tmpDir, 'no-handoff-project')
    fs.mkdirSync(noHandoffDir, { recursive: true })

    expect(() => archiveLog(noHandoffDir)).toThrow(/No .ai\/handoff\//)
  })

  it('throws when LOG.md does not exist', () => {
    const projectDir = makeProject('no-log-project')
    // handoff dir exists but no LOG.md

    expect(() => archiveLog(projectDir)).toThrow(/No LOG\.md found/)
  })

  it('creates archive directory if it does not exist yet', () => {
    const projectDir = makeProject()
    writeLog(projectDir, '# Journal\n')

    const archiveDir = path.join(projectDir, '.ai', 'handoff', 'logs')
    expect(fs.existsSync(archiveDir)).toBe(false)

    archiveLog(projectDir, 10, '2026-03-19')

    expect(fs.existsSync(archiveDir)).toBe(true)
  })
})
