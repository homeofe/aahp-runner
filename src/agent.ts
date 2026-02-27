import Anthropic from '@anthropic-ai/sdk'
import type { AahpProject, AahpTask } from './types.js'
import { buildSystemPrompt, saveManifest } from './scanner.js'
import { TOOL_DEFINITIONS, executeTool } from './tools.js'

const MAX_TURNS = 30

export interface AgentResult {
  success: boolean
  taskId: string
  turns: number
  committed: boolean
  summary: string
}

export async function runAgent(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  apiKey: string,
  onLog: (msg: string) => void
): Promise<AgentResult> {
  const client = new Anthropic({ apiKey })
  const systemPrompt = buildSystemPrompt(project, taskId, task)

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Start working on [${taskId}]: ${task.title}\n\nRead relevant files first, then implement, test, and commit. Update MANIFEST.json when done.`,
    },
  ]

  let turns = 0
  let committed = false
  let finalSummary = ''

  onLog(`\n🤖 Agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Repo: ${project.repoPath}`)

  while (turns < MAX_TURNS) {
    turns++
    onLog(`\n── Turn ${turns}/${MAX_TURNS} ──`)

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8096,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
      messages,
    })

    // Stream text content to log
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        onLog(`\n${block.text}`)
        finalSummary = block.text
      }
    }

    // Stop if model is done
    if (response.stop_reason === 'end_turn') {
      onLog('\n✅ Agent finished.')
      break
    }

    if (response.stop_reason !== 'tool_use') break

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      onLog(`\n🔧 Tool: ${block.name}`)
      const result = executeTool(
        block.name,
        block.input as Record<string, string>,
        project.repoPath,
        onLog
      )
      if (block.name === 'git_commit' && result.startsWith('OK:')) committed = true
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }

    // Append assistant turn + tool results
    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }

  // Mark task as done in manifest if agent committed
  if (committed) {
    const updated = {
      ...project.manifest,
      last_session: {
        ...project.manifest.last_session,
        agent: 'claude-opus-4-5',
        timestamp: new Date().toISOString(),
        phase: project.manifest.last_session.phase,
        duration_minutes: turns * 2,
      },
      tasks: {
        ...project.manifest.tasks,
        [taskId]: {
          ...task,
          status: 'done' as const,
          completed: new Date().toISOString(),
        },
      },
    }
    saveManifest(project, updated)
    onLog(`\n📝 MANIFEST.json updated — [${taskId}] marked done`)
  }

  return {
    success: committed,
    taskId,
    turns,
    committed,
    summary: finalSummary.slice(0, 200),
  }
}
