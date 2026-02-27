import { execSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { AahpProject, AahpTask, AahpManifest } from './types.js'
import { buildSystemPrompt, saveManifest } from './scanner.js'

export interface AgentResult {
  success: boolean
  taskId: string
  turns: number
  committed: boolean
  summary: string
}

/** Detect which backend to use: claude CLI (Claude Code) > Anthropic SDK (API key) > none */
function detectBackend(apiKey: string): 'claude-cli' | 'sdk' | 'none' {
  try {
    execSync('claude --version', { stdio: 'pipe' })
    return 'claude-cli'
  } catch {
    return apiKey ? 'sdk' : 'none'
  }
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

  const result = spawnSync(
    'claude',
    ['--print', '--dangerously-skip-permissions', '--output-format', 'text'],
    {
      cwd: project.repoPath,
      shell: true,
      encoding: 'utf8',
      input: userPrompt,
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    }
  )

  output = (result.stdout ?? '') + (result.stderr ?? '')
  onLog('\n' + output)

  // Reliable commit detection: check if a new commit was made in the last 5 minutes
  try {
    const recentCommit = execSync(
      'git log --oneline -1 --since="5 minutes ago"',
      { cwd: project.repoPath, encoding: 'utf8' }
    ).trim()
    committed = recentCommit.length > 0
  } catch {
    // Fall back to output heuristic if git check fails
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
  // Dynamic import so SDK is optional
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const { TOOL_DEFINITIONS, executeTool } = await import('./tools.js')

  const client = new Anthropic({ apiKey })
  const systemPrompt = buildSystemPrompt(project, taskId, task)
  const MAX_TURNS = 30

  const messages: InstanceType<typeof Anthropic>['messages'] extends { create: (p: infer P) => unknown } ? P extends { messages: infer M } ? M : never[] : never[] = [
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

/** Main entry point - auto-selects backend */
export async function runAgent(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  apiKey: string,
  onLog: (msg: string) => void
): Promise<AgentResult> {
  const backend = detectBackend(apiKey)

  if (backend === 'claude-cli') {
    return runViaClaudeCLI(project, taskId, task, onLog)
  }
  if (backend === 'sdk') {
    return runViaSDK(project, taskId, task, apiKey, onLog)
  }

  // backend === 'none' - no CLI and no API key
  throw new Error(
    'No Claude backend available.\n' +
    '  Option 1: Install Claude Code extension in VS Code (recommended - no API key needed)\n' +
    '  Option 2: aahp config --api-key "sk-ant-..."'
  )
}
