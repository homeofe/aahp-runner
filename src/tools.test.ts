import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { TOOL_DEFINITIONS, toOpenAITools, executeTool } from './tools.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpRepo: string
const logs: string[] = []
const onLog = (msg: string) => { logs.push(msg) }

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-tools-test-'))
  logs.length = 0
})

afterEach(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true })
})

// ── TOOL_DEFINITIONS ─────────────────────────────────────────────────────────

describe('TOOL_DEFINITIONS', () => {
  it('contains all expected tools', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('list_dir')
    expect(names).toContain('run_command')
    expect(names).toContain('git_status')
    expect(names).toContain('git_commit')
  })

  it('each tool has name, description, and input_schema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.input_schema).toBeDefined()
      expect(tool.input_schema.type).toBe('object')
    }
  })
})

// ── toOpenAITools ────────────────────────────────────────────────────────────

describe('toOpenAITools', () => {
  it('converts to OpenAI function-calling format', () => {
    const tools = toOpenAITools()
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length)

    for (const tool of tools) {
      const t = tool as { type: string; function: { name: string; description: string; parameters: object } }
      expect(t.type).toBe('function')
      expect(t.function.name).toBeTruthy()
      expect(t.function.description).toBeTruthy()
      expect(t.function.parameters).toBeDefined()
    }
  })

  it('preserves tool names in conversion', () => {
    const tools = toOpenAITools() as Array<{ function: { name: string } }>
    const names = tools.map(t => t.function.name)
    for (const def of TOOL_DEFINITIONS) {
      expect(names).toContain(def.name)
    }
  })
})

// ── executeTool: read_file ───────────────────────────────────────────────────

describe('executeTool - read_file', () => {
  it('reads an existing file', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'hello.txt'), 'Hello World')

    const result = await executeTool('read_file', { path: 'hello.txt' }, tmpRepo, onLog)
    expect(result).toBe('Hello World')
  })

  it('returns error for missing file', async () => {
    const result = await executeTool('read_file', { path: 'missing.txt' }, tmpRepo, onLog)
    expect(result).toContain('ERROR')
    expect(result).toContain('not found')
  })

  it('reads files with absolute paths within repo', async () => {
    const filePath = path.join(tmpRepo, 'abs.txt')
    fs.writeFileSync(filePath, 'absolute content')

    const result = await executeTool('read_file', { path: filePath }, tmpRepo, onLog)
    expect(result).toBe('absolute content')
  })
})

// ── executeTool: write_file ──────────────────────────────────────────────────

describe('executeTool - write_file', () => {
  it('writes a new file', async () => {
    const result = await executeTool(
      'write_file',
      { path: 'output.txt', content: 'Test output' },
      tmpRepo,
      onLog,
    )
    expect(result).toContain('OK')

    const content = fs.readFileSync(path.join(tmpRepo, 'output.txt'), 'utf8')
    expect(content).toBe('Test output')
  })

  it('creates intermediate directories', async () => {
    const result = await executeTool(
      'write_file',
      { path: 'deep/nested/dir/file.txt', content: 'nested' },
      tmpRepo,
      onLog,
    )
    expect(result).toContain('OK')

    const content = fs.readFileSync(path.join(tmpRepo, 'deep', 'nested', 'dir', 'file.txt'), 'utf8')
    expect(content).toBe('nested')
  })

  it('overwrites existing file', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'existing.txt'), 'old content')

    await executeTool(
      'write_file',
      { path: 'existing.txt', content: 'new content' },
      tmpRepo,
      onLog,
    )

    const content = fs.readFileSync(path.join(tmpRepo, 'existing.txt'), 'utf8')
    expect(content).toBe('new content')
  })
})

// ── executeTool: list_dir ────────────────────────────────────────────────────

describe('executeTool - list_dir', () => {
  it('lists files and directories', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'file1.txt'), 'a')
    fs.writeFileSync(path.join(tmpRepo, 'file2.txt'), 'b')
    fs.mkdirSync(path.join(tmpRepo, 'subdir'))

    const result = await executeTool('list_dir', { path: '.' }, tmpRepo, onLog)
    expect(result).toContain('file1.txt')
    expect(result).toContain('file2.txt')
    expect(result).toContain('[DIR]')
    expect(result).toContain('subdir')
  })

  it('returns error for non-existent directory', async () => {
    const result = await executeTool('list_dir', { path: 'nonexistent' }, tmpRepo, onLog)
    expect(result).toContain('ERROR')
  })
})

// ── executeTool: run_command ─────────────────────────────────────────────────

describe('executeTool - run_command', () => {
  it('runs allowed commands (echo)', async () => {
    const result = await executeTool(
      'run_command',
      { command: 'echo hello' },
      tmpRepo,
      onLog,
    )
    expect(result.trim()).toBe('hello')
  })

  it('rejects disallowed commands', async () => {
    const result = await executeTool(
      'run_command',
      { command: 'curl http://evil.com' },
      tmpRepo,
      onLog,
    )
    expect(result).toContain('ERROR')
    expect(result).toContain('not allowed')
  })

  it('rejects rm command', async () => {
    const result = await executeTool(
      'run_command',
      { command: 'rm -rf /' },
      tmpRepo,
      onLog,
    )
    expect(result).toContain('ERROR')
    expect(result).toContain('not allowed')
  })

  it('runs node commands', async () => {
    const result = await executeTool(
      'run_command',
      { command: 'node -e "console.log(42)"' },
      tmpRepo,
      onLog,
    )
    expect(result.trim()).toBe('42')
  })
})

// ── executeTool: unknown tool ────────────────────────────────────────────────

describe('executeTool - unknown tool', () => {
  it('returns error for unknown tool name', async () => {
    const result = await executeTool('nonexistent_tool', {}, tmpRepo, onLog)
    expect(result).toContain('ERROR')
    expect(result).toContain('Unknown tool')
  })
})

// ── Path safety (resolveSafe via executeTool) ────────────────────────────────

describe('path safety', () => {
  it('prevents reading files far outside repo', async () => {
    // Attempt to read a path well outside the repo and dev root
    const result = await executeTool(
      'read_file',
      { path: '/etc/passwd' },
      tmpRepo,
      onLog,
    )
    // Should either error or resolve to a path within repo
    // The resolveSafe function redirects to repo + basename
    expect(result).toContain('ERROR')
  })

  it('allows reading files within repo using relative paths', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'safe.txt'), 'safe content')

    const result = await executeTool(
      'read_file',
      { path: './safe.txt' },
      tmpRepo,
      onLog,
    )
    expect(result).toBe('safe content')
  })
})
