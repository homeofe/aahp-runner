import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

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
        onLog(`  ⚙️  ${cmd}`)
        // Safety: block destructive operations
        const blocked = ['rm -rf /', 'format', 'del /f /s /q c:\\']
        if (blocked.some(b => cmd.toLowerCase().includes(b))) {
          return 'ERROR: Command blocked for safety'
        }
        try {
          const output = execSync(cmd, { cwd, encoding: 'utf8', timeout: 60_000 })
          return output || '(no output)'
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
          execSync('git add -A', { cwd: repoPath })
          execSync(`git commit -m "${msg.replace(/"/g, '\\"')}" -m "${trailer}"`, { cwd: repoPath })
          const hash = execSync('git rev-parse --short HEAD', { cwd: repoPath, encoding: 'utf8' }).trim()
          onLog(`  💾 committed ${hash}: ${msg}`)
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
  const devRoot = path.dirname(repoPath)
  if (!resolved.startsWith(repoPath) && !resolved.startsWith(devRoot)) {
    return path.join(repoPath, path.basename(filePath))
  }
  return resolved
}
