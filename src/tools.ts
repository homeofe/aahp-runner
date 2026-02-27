import * as fs from 'fs'
import * as path from 'path'
import { execSync, execFileSync, spawnSync } from 'child_process'

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

// ── Tool executor ─────────────────────────────────────────────────────────────

export function executeTool(
  toolName: string,
  input: Record<string, string>,
  repoPath: string,
  onLog: (msg: string) => void
): string {
  try {
    switch (toolName) {

      case 'read_file': {
        const filePath = resolveSafe(input['path'] ?? '', repoPath)
        if (!fs.existsSync(filePath)) return `ERROR: File not found: ${filePath}`
        const content = fs.readFileSync(filePath, 'utf8')
        onLog(`  📄 read ${path.relative(repoPath, filePath)} (${content.length} chars)`)
        return content
      }

      case 'write_file': {
        const filePath = resolveSafe(input['path'] ?? '', repoPath)
        const content = input['content'] ?? ''
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, content, 'utf8')
        onLog(`  ✏️  wrote ${path.relative(repoPath, filePath)} (${content.length} chars)`)
        return `OK: wrote ${filePath}`
      }

      case 'list_dir': {
        const dirPath = resolveSafe(input['path'] ?? '.', repoPath)
        if (!fs.existsSync(dirPath)) return `ERROR: Directory not found: ${dirPath}`
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
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
        // Parse the command string into binary and arguments
        const parts = cmd.trim().split(/\s+/)
        const binary = parts[0] ?? ''
        const args = parts.slice(1)
        if (!ALLOWED_COMMANDS.includes(binary.toLowerCase())) {
          return `ERROR: Command "${binary}" is not allowed. Permitted commands: ${ALLOWED_COMMANDS.join(', ')}`
        }
        try {
          const result = spawnSync(binary, args, {
            cwd,
            encoding: 'utf8',
            timeout: 60_000,
            shell: false,
          })
          if (result.error) {
            return `EXIT ERROR:\n${result.error.message}`
          }
          if (result.status !== 0) {
            return `EXIT ERROR:\n${result.stdout ?? ''}${result.stderr ?? ''}`
          }
          return result.stdout || '(no output)'
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string; message?: string }
          return `EXIT ERROR:\n${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`
        }
      }

      case 'git_status': {
        const status = execSync('git status --short', { cwd: repoPath, encoding: 'utf8' })
        const log = execSync('git --no-pager log --oneline -5', { cwd: repoPath, encoding: 'utf8' })
        return `=== Status ===\n${status}\n=== Recent commits ===\n${log}`
      }

      case 'git_commit': {
        const msg = input['message'] ?? 'chore: agent update'
        const trailer = 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
        try {
          execFileSync('git', ['add', '-A'], { cwd: repoPath })
          execFileSync('git', ['commit', '-m', msg, '-m', trailer], { cwd: repoPath })
          const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
          onLog(`  committed ${hash}: ${msg}`)
          return `OK: committed ${hash}`
        } catch (e: unknown) {
          const err = e as { stderr?: string; message?: string }
          return `ERROR: ${err.stderr ?? err.message ?? String(e)}`
        }
      }

      default:
        return `ERROR: Unknown tool: ${toolName}`
    }
  } catch (e: unknown) {
    return `ERROR: ${String(e)}`
  }
}

function resolveSafe(filePath: string, repoPath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(repoPath, filePath)
  // Allow paths within repo or within parent dev root (one level up)
  // Use path.sep suffix to prevent prefix collisions (e.g. C:\dev matching C:\developer)
  const devRoot = path.dirname(repoPath)
  const inRepo = resolved === repoPath || resolved.startsWith(repoPath + path.sep)
  const inDevRoot = resolved === devRoot || resolved.startsWith(devRoot + path.sep)
  if (!inRepo && !inDevRoot) {
    return path.join(repoPath, path.basename(filePath))
  }
  return resolved
}
