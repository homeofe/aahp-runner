/**
 * Tests for `aahp run --dry-run` behaviour.
 *
 * Tests use the compiled dist/cli.js to validate the flag end-to-end.
 * The build must be current before running (npm run build).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

// ── Path helpers ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

/** Absolute path to the compiled CLI entry point. */
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli.js')

// ── Temp root helpers ─────────────────────────────────────────────────────────

let tmpRoot: string

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-dryrun-test-'))
}

interface ManifestTask {
  title: string
  status: string
  priority: string
  depends_on: string[]
  created: string
  github_issue?: number
}

function writeProject(
  rootDir: string,
  repoName: string,
  tasks: Record<string, ManifestTask>,
): void {
  const handoffDir = path.join(rootDir, repoName, '.ai', 'handoff')
  fs.mkdirSync(handoffDir, { recursive: true })
  const manifest = {
    aahp_version: '3.0',
    project: repoName,
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
    tasks,
  }
  fs.writeFileSync(
    path.join(handoffDir, 'MANIFEST.json'),
    JSON.stringify(manifest, null, 2),
  )
}

function makeReadyTask(
  title: string,
  priority = 'medium',
  githubIssue?: number,
): ManifestTask {
  const t: ManifestTask = {
    title,
    status: 'ready',
    priority,
    depends_on: [],
    created: '2026-01-01T00:00:00Z',
  }
  if (githubIssue !== undefined) t.github_issue = githubIssue
  return t
}

/**
 * Run the compiled CLI with given extra args and capture combined stdout.
 * Always passes --dry-run and --root <tmpRoot>.
 */
function runDryRun(extraArgs: string, root = tmpRoot): string {
  return execSync(
    `node "${CLI_PATH}" run --dry-run --root "${root}" ${extraArgs}`,
    { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } },
  )
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  tmpRoot = makeTmpRoot()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('aahp run --dry-run', () => {
  it('shows dry-run header in output', () => {
    writeProject(tmpRoot, 'my-app', {
      'T-001': makeReadyTask('Add feature X', 'high'),
    })

    const output = runDryRun('--all --yes')
    expect(output).toContain('Dry-run mode')
    // Must not spawn any real agents
    expect(output).not.toContain('Spawning')
  })

  it('lists the selected task ID', () => {
    writeProject(tmpRoot, 'api-service', {
      'T-001': makeReadyTask('Implement auth endpoint', 'high'),
    })

    const output = runDryRun('--all --yes --backend sdk')
    expect(output).toContain('T-001')
  })

  it('lists the project name', () => {
    writeProject(tmpRoot, 'api-service', {
      'T-001': makeReadyTask('Implement auth endpoint', 'high'),
    })

    const output = runDryRun('--all --yes')
    expect(output).toContain('api-service')
  })

  it('lists the agent backend that would be used', () => {
    writeProject(tmpRoot, 'api-service', {
      'T-001': makeReadyTask('Implement auth endpoint', 'high'),
    })

    const output = runDryRun('--all --yes --backend sdk')
    expect(output).toContain('sdk')
  })

  it('lists the task title', () => {
    writeProject(tmpRoot, 'api-service', {
      'T-001': makeReadyTask('Implement auth endpoint', 'high'),
    })

    const output = runDryRun('--all --yes')
    expect(output).toContain('Implement auth endpoint')
  })

  it('shows priority of the selected task', () => {
    writeProject(tmpRoot, 'infra-repo', {
      'T-001': makeReadyTask('Deploy prod', 'high'),
    })

    const output = runDryRun('--all --yes')
    expect(output).toContain('high')
  })

  it('shows timeout config that would be used', () => {
    writeProject(tmpRoot, 'worker', {
      'T-001': makeReadyTask('Process queue'),
    })

    const output = runDryRun('--all --yes --timeout 25')
    expect(output).toContain('25')
  })

  it('lists all projects when --all is passed', () => {
    writeProject(tmpRoot, 'repo-alpha', { 'T-001': makeReadyTask('Task alpha') })
    writeProject(tmpRoot, 'repo-beta',  { 'T-001': makeReadyTask('Task beta') })

    const output = runDryRun('--all --yes')
    expect(output).toContain('repo-alpha')
    expect(output).toContain('repo-beta')
    expect(output).toContain('Would run 2 agents')
  })

  it('exits without running agents — no "Spawning" message', () => {
    writeProject(tmpRoot, 'safe-repo', {
      'T-001': makeReadyTask('Dangerous migration'),
    })

    const output = runDryRun('--all --yes')
    expect(output).not.toContain('Spawning')
    expect(output).toContain('Re-run without --dry-run')
  })

  it('shows github issue number when present on the task', () => {
    writeProject(tmpRoot, 'linked-repo', {
      'T-001': makeReadyTask('Fix bug from issue', 'medium', 42),
    })

    const output = runDryRun('--all --yes')
    expect(output).toContain('#42')
  })

  it('shows all-up-to-date / no actionable message when no ready tasks exist', () => {
    writeProject(tmpRoot, 'idle-repo', {
      'T-001': {
        title: 'Done task',
        status: 'done',
        priority: 'low',
        depends_on: [],
        created: '2026-01-01T00:00:00Z',
      },
    })

    // When there are no actionable tasks, the early-exit branch fires before
    // dry-run and prints the "up to date" message.
    const output = runDryRun('--all --yes')
    expect(output).toMatch(/up to date|no actionable|nothing would run/i)
  })

  it('shows follow-up info in config summary when --follow-up is set', () => {
    writeProject(tmpRoot, 'chained-repo', {
      'T-001': makeReadyTask('First task'),
    })

    const output = runDryRun('--all --yes --follow-up')
    expect(output).toContain('follow-up')
  })

  it('filters to a named project and shows "Would run 1 agent"', () => {
    writeProject(tmpRoot, 'target-app', { 'T-001': makeReadyTask('Do the thing') })
    writeProject(tmpRoot, 'other-app',  { 'T-001': makeReadyTask('Other thing') })

    const output = runDryRun('target-app --yes')
    expect(output).toContain('target-app')
    expect(output).toContain('Would run 1 agent')
  })

  it('does not actually start any agent process', () => {
    writeProject(tmpRoot, 'no-run-repo', {
      'T-001': makeReadyTask('Should not run'),
    })

    // Running in dry-run must finish quickly (well under 5s) and not attempt
    // to spawn claude/copilot/sdk backends.
    const start = Date.now()
    runDryRun('--all --yes --backend sdk')
    const elapsed = Date.now() - start
    // If an agent was actually started it would take much longer than 2s
    expect(elapsed).toBeLessThan(5000)
  })
})
