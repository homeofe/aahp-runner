import { execSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { AahpProject, AahpTask, AahpManifest } from './types.js'
import { buildSystemPrompt, saveManifest } from './scanner.js'
import { TOOL_DEFINITIONS, toOpenAITools, executeTool } from './tools.js'

export interface AgentResult {
  success: boolean
  taskId: string
  turns: number
  committed: boolean
  summary: string
}

type Backend = 'claude-cli' | 'copilot' | 'sdk' | 'none'

// ── Backend detection ─────────────────────────────────────────────────────────

function detectClaudeCLI(): boolean {
  try { execSync('claude --version', { stdio: 'pipe' }); return true } catch { return false }
}

/** Returns GitHub token from `gh auth token`, or empty string if unavailable. */
function detectCopilotToken(): string {
  try {
    return execSync('gh auth token', { stdio: 'pipe', encoding: 'utf8' }).trim()
  } catch { return '' }
}

/**
 * Pick a backend.
 * explicit 'auto' (or undefined): claude-cli > copilot > sdk > none
 * explicit 'claude'  → claude-cli only
 * explicit 'copilot' → copilot only (fails if gh token unavailable)
 * explicit 'sdk'     → sdk only
 */
function resolveBackend(
  apiKey: string,
  explicit: 'auto' | 'claude' | 'copilot' | 'sdk' = 'auto'
): { backend: Backend; copilotToken: string } {
  if (explicit === 'claude') {
    return detectClaudeCLI()
      ? { backend: 'claude-cli', copilotToken: '' }
      : { backend: 'none', copilotToken: '' }
  }
  if (explicit === 'sdk') {
    return { backend: apiKey ? 'sdk' : 'none', copilotToken: '' }
  }
  if (explicit === 'copilot') {
    const token = detectCopilotToken()
    return token ? { backend: 'copilot', copilotToken: token } : { backend: 'none', copilotToken: '' }
  }
  // auto
  if (detectClaudeCLI()) return { backend: 'claude-cli', copilotToken: '' }
  const token = detectCopilotToken()
  if (token) return { backend: 'copilot', copilotToken: token }
  if (apiKey) return { backend: 'sdk', copilotToken: '' }
  return { backend: 'none', copilotToken: '' }
}

/** Run agent via `claude` CLI (uses Claude Code VS Code auth - no API key needed) */
async function runViaClaudeCLI(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  onLog: (msg: string) => void
): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt(project, taskId, task)
  const userPrompt = `${systemPrompt}\n\n---\n\nStart working on [${taskId}]: ${task.title}\n\nRead relevant files first, then implement, test, and commit. Mark the task done in MANIFEST.json when finished.`

  onLog(`\n🤖 Claude Code agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Repo: ${project.repoPath}`)
  onLog(`   Backend: claude CLI (Claude Code - no API key needed)`)

  let output = ''
  let committed = false

  await new Promise<void>((resolve) => {
    // Use async spawn so 9 parallel agents actually run concurrently
    const proc = spawn(
      'claude',
      ['--print', '--dangerously-skip-permissions', '--output-format', 'text'],
      { cwd: project.repoPath, shell: true, timeout: 10 * 60 * 1000 }
    )

    proc.stdin.write(userPrompt)
    proc.stdin.end()

    // Stream output in real-time as each chunk arrives
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      onLog(text)
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      onLog(chunk.toString())
    })

    proc.on('close', () => resolve())
    proc.on('error', (err) => { onLog(`\n❌ spawn error: ${err.message}`); resolve() })
  })

  // Reliable commit detection: check if a new commit was made in the last 5 minutes
  try {
    const recentCommit = execSync(
      'git log --oneline -1 --since="5 minutes ago"',
      { cwd: project.repoPath, encoding: 'utf8' }
    ).trim()
    committed = recentCommit.length > 0
  } catch {
    committed = output.toLowerCase().includes('git commit') ||
      output.toLowerCase().includes('committed') ||
      output.toLowerCase().includes('[main ') ||
      output.toLowerCase().includes('[master ')
  }

  if (committed) {
    markTaskDone(project, taskId, task, 1, 'claude-code')
    onLog(`\n📝 MANIFEST.json updated - [${taskId}] marked done`)
  }

  return {
    success: committed,
    taskId,
    turns: 1,
    committed,
    summary: output.slice(0, 300),
  }
}

/** Run agent via Anthropic SDK (direct API key) - fallback if claude CLI not available */
async function runViaSDK(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  apiKey: string,
  onLog: (msg: string) => void
): Promise<AgentResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  const client = new Anthropic({ apiKey })
  const systemPrompt = buildSystemPrompt(project, taskId, task)
  const MAX_TURNS = 30

  const messages: any[] = [
    {
      role: 'user' as const,
      content: `Start working on [${taskId}]: ${task.title}\n\nRead relevant files first, then implement, test, and commit. Update MANIFEST.json when done.`,
    },
  ]

  let turns = 0
  let committed = false
  let finalSummary = ''

  onLog(`\n🤖 SDK agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Backend: Anthropic SDK (API key)`)

  while (turns < MAX_TURNS) {
    turns++
    onLog(`\n── Turn ${turns}/${MAX_TURNS} ──`)

    const response = await (client.messages as any).create({
      model: 'claude-opus-4-5',
      max_tokens: 8192,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages,
    })

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        onLog(`\n${block.text}`)
        finalSummary = block.text
      }
    }

    if (response.stop_reason === 'end_turn') { onLog('\n✅ Agent finished.'); break }
    if (response.stop_reason !== 'tool_use') break

    const toolResults: any[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      onLog(`\n🔧 Tool: ${block.name}`)
      const result = executeTool(block.name, block.input as Record<string, string>, project.repoPath, onLog)
      if (block.name === 'git_commit' && result.startsWith('OK:')) committed = true
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }

    messages.push({ role: 'assistant' as const, content: response.content })
    messages.push({ role: 'user' as const, content: toolResults })
  }

  if (committed) {
    markTaskDone(project, taskId, task, turns, 'claude-opus-4-5')
    onLog(`\n📝 MANIFEST.json updated - [${taskId}] marked done`)
  }

  return { success: committed, taskId, turns, committed, summary: finalSummary.slice(0, 200) }
}

// ── GitHub Copilot backend (via GitHub Copilot API - OpenAI-compatible) ───────

/**
 * Calls the GitHub Copilot chat completions API using an OpenAI-compatible
 * format. Authentication uses the token from `gh auth token`.
 *
 * Endpoint: https://api.githubcopilot.com/chat/completions
 * Model:    gpt-4o (default) - same model used by GitHub Copilot Chat
 */
async function runViaCopilot(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  copilotToken: string,
  onLog: (msg: string) => void
): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt(project, taskId, task)
  const MAX_TURNS = 30
  const COPILOT_ENDPOINT = 'https://api.githubcopilot.com/chat/completions'
  const MODEL = 'gpt-4o'

  const openAITools = toOpenAITools()

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Start working on [${taskId}]: ${task.title}\n\nRead relevant files first, then implement, test, and commit. Update MANIFEST.json when done.`,
    },
  ]

  let turns = 0
  let committed = false
  let finalSummary = ''

  onLog(`\n🤖 GitHub Copilot agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Backend: GitHub Copilot (${MODEL})`)
  onLog(`   Repo: ${project.repoPath}`)

  while (turns < MAX_TURNS) {
    turns++
    onLog(`\n── Turn ${turns}/${MAX_TURNS} ──`)

    let response: Response
    try {
      response = await fetch(COPILOT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${copilotToken}`,
          'Content-Type': 'application/json',
          'Editor-Version': 'aahp-runner/0.1',
          'Copilot-Integration-Id': 'aahp-runner',
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools: openAITools,
          tool_choice: 'auto',
          max_tokens: 4096,
        }),
      })
    } catch (err) {
      onLog(`\n❌ Network error: ${String(err)}`)
      break
    }

    if (!response.ok) {
      const body = await response.text()
      onLog(`\n❌ Copilot API error ${response.status}: ${body.slice(0, 200)}`)
      // 401 = token expired/invalid; no point retrying
      if (response.status === 401) {
        throw new Error('GitHub Copilot token invalid or expired. Run: gh auth refresh')
      }
      break
    }

    const data = await response.json() as any
    const choice = data.choices?.[0]
    if (!choice) break

    const msg = choice.message
    if (msg.content?.trim()) {
      onLog(`\n${msg.content}`)
      finalSummary = msg.content
    }

    // No tool calls - agent is done
    if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
      onLog('\n✅ Copilot agent finished.')
      break
    }

    // Execute tool calls
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls })

    for (const call of msg.tool_calls) {
      const fnName: string = call.function.name
      let fnArgs: Record<string, string> = {}
      try { fnArgs = JSON.parse(call.function.arguments) } catch { /* use empty args */ }

      onLog(`\n🔧 Tool: ${fnName}(${JSON.stringify(fnArgs).slice(0, 80)})`)
      const result = executeTool(fnName, fnArgs, project.repoPath, onLog)
      onLog(`   -> ${result.slice(0, 120)}`)

      if (fnName === 'git_commit' && result.startsWith('OK:')) committed = true

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      })
    }
  }

  if (committed) {
    markTaskDone(project, taskId, task, turns, `github-copilot/${MODEL}`)
    onLog(`\n📝 MANIFEST.json updated - [${taskId}] marked done`)
  }

  return { success: committed, taskId, turns, committed, summary: finalSummary.slice(0, 200) }
}

function markTaskDone(project: AahpProject, taskId: string, task: AahpTask, turns: number, agentName: string) {
  // Re-read manifest from disk to avoid overwriting changes made by the agent
  const manifestPath = path.join(project.handoffDir, 'MANIFEST.json')
  let currentManifest: AahpManifest
  try {
    currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AahpManifest
  } catch {
    // Fall back to the in-memory snapshot if disk read fails
    currentManifest = project.manifest
  }

  const updated = {
    ...currentManifest,
    last_session: {
      ...currentManifest.last_session,
      agent: agentName,
      timestamp: new Date().toISOString(),
      phase: currentManifest.last_session.phase,
      duration_minutes: turns * 2,
    },
    tasks: {
      ...currentManifest.tasks,
      [taskId]: { ...task, status: 'done' as const, completed: new Date().toISOString() },
    },
  }
  saveManifest(project, updated)
}

/** Main entry point - selects backend based on explicit preference or auto-detection */
export async function runAgent(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  apiKey: string,
  onLog: (msg: string) => void,
  explicitBackend: 'auto' | 'claude' | 'copilot' | 'sdk' = 'auto'
): Promise<AgentResult> {
  const { backend, copilotToken } = resolveBackend(apiKey, explicitBackend)

  if (backend === 'claude-cli') return runViaClaudeCLI(project, taskId, task, onLog)
  if (backend === 'copilot') return runViaCopilot(project, taskId, task, copilotToken, onLog)
  if (backend === 'sdk') return runViaSDK(project, taskId, task, apiKey, onLog)

  // backend === 'none'
  const hint = explicitBackend === 'copilot'
    ? 'GitHub Copilot token not found. Make sure you are signed in: gh auth login'
    : explicitBackend === 'claude'
      ? 'Claude Code CLI not found. Install the Claude Code VS Code extension.'
      : 'No agent backend available.\n' +
        '  Option 1: Install Claude Code extension in VS Code (no API key needed)\n' +
        '  Option 2: Sign in to GitHub CLI - gh auth login  (uses your Copilot subscription)\n' +
        '  Option 3: aahp config --api-key "sk-ant-..."  (Anthropic API key)'
  throw new Error(hint)
}
