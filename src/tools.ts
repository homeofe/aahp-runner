import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

// ── Shared async command runner ──────────────────────────────────────────────

export async function runAsync(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number = 60000,
  shell: boolean = process.platform === 'win32'
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(binary, args, { cwd, shell, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { proc.kill(); resolve({ stdout, stderr, code: null }) }, timeoutMs)
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
    proc.on('error', (err) => { clearTimeout(timer); resolve({ stdout: '', stderr: err.message, code: 1 }) })
  })
}

// ── Tool definitions for Claude tool_use ──────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Path must be within the project repo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative or absolute path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file with new content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative or absolute path to the file' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories at a path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the project directory. Use for builds, tests, installs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (defaults to repo root)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_status',
    description: 'Get git status and recent log for the repo.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and create a git commit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Conventional commit message' },
      },
      required: ['message'],
    },
  },
] as const

// ── OpenAI-compatible tool definitions (for Copilot backend) ─────────────────

/** Convert Anthropic tool definitions to OpenAI function-calling format. */
export function toOpenAITools(): object[] {
  return TOOL_DEFINITIONS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: (t.input_schema as any).properties ?? {},
        required: (t.input_schema as any).required ?? [],
      },
    },
  }))
}

// ── Tool executor (async - does not block the event loop) ────────────────────

export async function executeTool(
  toolName: string,
  input: Record<string, string>,
  repoPath: string,
  onLog: (msg: string) => void
): Promise<string> {
  try {
    switch (toolName) {

      case 'read_file': {
        const filePath = resolveSafe(input['path'] ?? '', repoPath)
        try {
          await fs.promises.access(filePath)
        } catch {
          return `ERROR: File not found: ${filePath}`
        }
        const content = await fs.promises.readFile(filePath, 'utf8')
        onLog(`  read ${path.relative(repoPath, filePath)} (${content.length} chars)`)
        return content
      }

      case 'write_file': {
        const filePath = resolveSafe(input['path'] ?? '', repoPath)
        const content = input['content'] ?? ''
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
        await fs.promises.writeFile(filePath, content, 'utf8')
        onLog(`  wrote ${path.relative(repoPath, filePath)} (${content.length} chars)`)
        return `OK: wrote ${filePath}`
      }

      case 'list_dir': {
        const dirPath = resolveSafe(input['path'] ?? '.', repoPath)
        try {
          await fs.promises.access(dirPath)
        } catch {
          return `ERROR: Directory not found: ${dirPath}`
        }
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
        return entries
          .map(e => `${e.isDirectory() ? '[DIR] ' : '      '}${e.name}`)
          .join('\n')
      }

      case 'run_command': {
        const cmd = input['command'] ?? ''
        const cwd = input['cwd'] ? resolveSafe(input['cwd'], repoPath) : repoPath
        onLog(`  ${cmd}`)
        // Safety: strict allowlist - only permitted command prefixes
        const ALLOWED_COMMANDS = [
          'git', 'npm', 'pnpm', 'node', 'npx', 'tsc', 'vitest',
          'jest', 'echo', 'ls', 'dir', 'cat', 'type', 'pwd',
        ]
        // Parse command into [binary, ...args] to avoid passing the whole string
        // to the shell (prevents command injection via shell metacharacters)
        const [binary, ...args] = parseCommand(cmd)
        if (!binary || !ALLOWED_COMMANDS.includes(binary.toLowerCase())) {
          return `ERROR: Command "${binary ?? ''}" is not allowed. Permitted commands: ${ALLOWED_COMMANDS.join(', ')}`
        }
        // shell=true only on Windows where npm/npx/tsc ship as .cmd files;
        // on POSIX we pass args directly so no shell expansion occurs
        const useShell = process.platform === 'win32'
        const result = await runAsync(binary, args, cwd, 60000, useShell)
        if (result.code === null) {
          return `EXIT ERROR: command timed out`
        }
        if (result.code !== 0) {
          return `EXIT ERROR:\n${result.stdout}${result.stderr}`
        }
        return result.stdout || '(no output)'
      }

      case 'git_status': {
        const statusResult = await runAsync('git', ['status', '--short'], repoPath)
        const logResult = await runAsync('git', ['--no-pager', 'log', '--oneline', '-5'], repoPath)
        return `=== Status ===\n${statusResult.stdout}\n=== Recent commits ===\n${logResult.stdout}`
      }

      case 'git_commit': {
        const msg = input['message'] ?? 'chore: agent update'
        const trailer = 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
        const addResult = await runAsync('git', ['add', '-A'], repoPath)
        if (addResult.code !== 0) {
          return `ERROR: git add failed: ${addResult.stderr}`
        }
        const commitResult = await runAsync('git', ['commit', '-m', msg, '-m', trailer], repoPath)
        if (commitResult.code !== 0) {
          return `ERROR: ${commitResult.stderr}`
        }
        const hashResult = await runAsync('git', ['rev-parse', '--short', 'HEAD'], repoPath, 5000)
        const hash = hashResult.stdout.trim()
        onLog(`  committed ${hash}: ${msg}`)
        return `OK: committed ${hash}`
      }

      default:
        return `ERROR: Unknown tool: ${toolName}`
    }
  } catch (e: unknown) {
    return `ERROR: ${String(e)}`
  }
}

/** Split a shell-like command string into [binary, ...args] respecting quoted strings. */
function parseCommand(cmd: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current) { tokens.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

function resolveSafe(filePath: string, repoPath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(repoPath, filePath)
  // Confine all file-tool access to the target repo. A path that escapes the
  // repo (including into the parent dev root or a sibling repo) is redirected to
  // repo + basename, so an agent can never read or write outside the repository
  // it was dispatched against.
  // Use a path.sep suffix to prevent prefix collisions (e.g. C:\repo matching C:\repo-2).
  const inRepo = resolved === repoPath || resolved.startsWith(repoPath + path.sep)
  if (!inRepo) {
    return path.join(repoPath, path.basename(filePath))
  }
  return resolved
}
