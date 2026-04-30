import { spawn } from 'child_process'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { AahpProject, AahpTask, AahpManifest } from './types.js'
import { buildSystemPrompt, buildPlanningPrompt, saveManifest } from './scanner.js'
import { TOOL_DEFINITIONS, toOpenAITools, executeTool, runAsync } from './tools.js'
import { agentLogPath, writeLog } from './status-board.js'
import { ResourceMonitor, currentProcessSnapshot } from './resource-monitor.js'

export interface AgentResult {
  success: boolean
  taskId: string
  turns: number
  committed: boolean
  summary: string
  logFile: string   // path to full log
  cpuAvg?: number   // average CPU % during run
  memPeakMB?: number // peak memory in MB
  // ── Abort marker (issue #28) ────────────────────────────────────────────────
  // Set to true when the run was terminated by a POST /abort from the hub.
  // Implies success=false; allows recordMetric to distinguish abort from failure.
  aborted?: boolean
}

type Backend = 'claude-cli' | 'gemini' | 'codex' | 'copilot' | 'sdk' | 'none'

// ── Async HEAD helper for commit detection ───────────────────────────────────

async function getHead(repoPath: string): Promise<string> {
  const { stdout } = await runAsync('git', ['rev-parse', 'HEAD'], repoPath, 5000)
  return stdout.trim()
}

// ── Backend detection (cached, async) ────────────────────────────────────────

async function detectClaudeCLI(): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'
  const { code } = await runAsync(cmd, ['--version'], process.cwd(), 10000)
  return code === 0
}

async function detectGeminiCLI(): Promise<boolean> {
  const { code } = await runAsync('gemini', ['--version'], process.cwd(), 10000)
  return code === 0
}

async function detectCodexCLI(): Promise<boolean> {
  const { code } = await runAsync('codex', ['--version'], process.cwd(), 10000)
  return code === 0
}

/** Returns GitHub token from `gh auth token`, or empty string if unavailable. */
async function detectCopilotToken(): Promise<string> {
  const { stdout, code } = await runAsync('gh', ['auth', 'token'], process.cwd(), 10000)
  return code === 0 ? stdout.trim() : ''
}

let cachedBackend: { backend: Backend; copilotToken: string } | undefined

/**
 * Pick a backend.
 * explicit 'auto': claude-cli > gemini > codex > copilot > sdk > none
 * explicit 'claude'  - claude-cli only
 * explicit 'gemini'  - gemini CLI only
 * explicit 'codex'   - codex CLI only
 * explicit 'copilot' - copilot only (fails if gh token unavailable)
 * explicit 'sdk'     - sdk only
 */
async function resolveBackend(
  apiKey: string,
  explicit: 'auto' | 'claude' | 'gemini' | 'codex' | 'copilot' | 'sdk' = 'auto'
): Promise<{ backend: Backend; copilotToken: string }> {
  // Explicit backend selections bypass cache since they are specific requests
  if (explicit === 'claude') {
    const found = await detectClaudeCLI()
    return found
      ? { backend: 'claude-cli', copilotToken: '' }
      : { backend: 'none', copilotToken: '' }
  }
  if (explicit === 'gemini') {
    return (await detectGeminiCLI())
      ? { backend: 'gemini', copilotToken: '' }
      : { backend: 'none', copilotToken: '' }
  }
  if (explicit === 'codex') {
    return (await detectCodexCLI())
      ? { backend: 'codex', copilotToken: '' }
      : { backend: 'none', copilotToken: '' }
  }
  if (explicit === 'sdk') {
    return { backend: apiKey ? 'sdk' : 'none', copilotToken: '' }
  }
  if (explicit === 'copilot') {
    const token = await detectCopilotToken()
    return token ? { backend: 'copilot', copilotToken: token } : { backend: 'none', copilotToken: '' }
  }

  // Auto mode - use cache if available
  if (cachedBackend) return cachedBackend

  if (await detectClaudeCLI()) {
    cachedBackend = { backend: 'claude-cli', copilotToken: '' }
    return cachedBackend
  }
  if (await detectGeminiCLI()) {
    cachedBackend = { backend: 'gemini', copilotToken: '' }
    return cachedBackend
  }
  if (await detectCodexCLI()) {
    cachedBackend = { backend: 'codex', copilotToken: '' }
    return cachedBackend
  }
  const token = await detectCopilotToken()
  if (token) {
    cachedBackend = { backend: 'copilot', copilotToken: token }
    return cachedBackend
  }
  if (apiKey) {
    cachedBackend = { backend: 'sdk', copilotToken: '' }
    return cachedBackend
  }
  cachedBackend = { backend: 'none', copilotToken: '' }
  return cachedBackend
}

/** Run agent via `claude` CLI (uses Claude Code VS Code auth - no API key needed) */
async function runViaClaudeCLI(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  onLog: (msg: string) => void,
  timeoutMs: number = 10 * 60 * 1000,
  abortSignal?: AbortSignal
): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt(project, taskId, task)
  const userPrompt = `${systemPrompt}\n\n---\n\nStart working on [${taskId}]: ${task.title}\n\nRead relevant files first, then implement, test, and commit. Mark the task done in MANIFEST.json when finished.`

  onLog(`\nClaude Code agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Repo: ${project.repoPath}`)
  onLog(`   Backend: claude CLI (Claude Code - no API key needed)`)
  onLog(`   Timeout: ${Math.round(timeoutMs / 60000)}m`)

  const logFile = agentLogPath(project.name, project.repoPath)
  const ts = () => new Date().toISOString().slice(11, 19)
  const startMs = Date.now()
  writeLog(logFile, `[${ts()}] AAHP START  ${taskId} · ${task.title}\n`)
  writeLog(logFile, `[${ts()}] BACKEND     claude-cli · timeout ${Math.round(timeoutMs / 60000)}m\n`)
  if (task.github_issue) writeLog(logFile, `[${ts()}] ISSUE       #${task.github_issue} in ${task.github_repo}\n`)
  writeLog(logFile, `${'─'.repeat(60)}\n`)

  // Record HEAD before spawn for reliable commit detection
  const headBefore = await getHead(project.repoPath)

  let output = ''
  let exitCode: number | null = null
  let aborted = false

  const CLAUDE_TIMEOUT_MS = timeoutMs
  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'

  let resMonitor: ResourceMonitor | undefined

  await new Promise<void>((resolve) => {
    const proc = spawn(
      claudeCmd,
      [
        '--print',
        '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep,WebFetch',
        '--output-format', 'text',
      ],
      {
        cwd: project.repoPath,
        shell: process.platform === 'win32',
        env: { ...process.env, CLAUDECODE: undefined },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )

    // Start resource monitoring on the child process
    if (proc.pid) {
      resMonitor = new ResourceMonitor(proc.pid)
      resMonitor.start()
    }

    // Manual timeout - spawn's timeout option is silently ignored for async spawn
    const timer = setTimeout(() => {
      onLog(`\nClaude CLI timed out after ${CLAUDE_TIMEOUT_MS / 1000}s - sending SIGTERM`)
      proc.kill('SIGTERM')
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000)
    }, CLAUDE_TIMEOUT_MS)

    // External abort hook (issue #28) - SIGTERM then SIGKILL after 5s
    const abortHandler = () => {
      aborted = true
      onLog(`\nClaude CLI aborted by control endpoint - sending SIGTERM`)
      try { proc.kill('SIGTERM') } catch { /* already exited */ }
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000)
    }
    if (abortSignal) {
      if (abortSignal.aborted) abortHandler()
      else abortSignal.addEventListener('abort', abortHandler, { once: true })
    }

    proc.stdin.write(userPrompt)
    proc.stdin.end()

    // Stream output in real-time as each chunk arrives
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      writeLog(logFile, text)   // always write to file
      onLog(text)               // last line shown in status board
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      writeLog(logFile, chunk.toString())
      onLog(chunk.toString())
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', abortHandler)
      resMonitor?.stop()
      exitCode = code
      if (code !== 0 && !aborted) onLog(`Claude CLI exited with code ${code}`)
      resolve()
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', abortHandler)
      resMonitor?.stop()
      onLog(`\nspawn error: ${err.message}`)
      resolve()
    })
  })

  writeLog(logFile, `\n${'─'.repeat(60)}\n`)

  // Reliable commit detection: compare HEAD before and after
  let committed = false
  try {
    const headAfter = await getHead(project.repoPath)
    committed = headAfter !== headBefore && headAfter.length > 0
  } catch {
    // Fallback: check output text for commit indicators
    committed = output.toLowerCase().includes('git commit') ||
      output.toLowerCase().includes('committed') ||
      output.toLowerCase().includes('[main ') ||
      output.toLowerCase().includes('[master ')
  }

  if (committed && !aborted) {
    markTaskDone(project, taskId, task, 1, 'claude-code')
    onLog(`\nMANIFEST.json updated - [${taskId}] marked done`)
  }

  const cliStatus = aborted ? 'ABORT ' : (committed ? 'DONE  ' : 'FAILED')
  writeLog(logFile, `[${ts()}] AAHP ${cliStatus}  ${taskId} · committed:${committed} · ${Math.round((Date.now() - startMs) / 1000)}s\n`)

  return {
    success: committed && !aborted,
    taskId,
    turns: 1,
    committed,
    summary: output.slice(0, 300),
    logFile,
    cpuAvg: resMonitor?.avgCpu(),
    memPeakMB: resMonitor?.peakMemMB(),
    aborted: aborted || undefined,
  }
}

/**
 * Generic CLI runner used by both Gemini and Codex backends.
 * Spawns a CLI subprocess, writes the prompt to stdin, and captures output.
 * Commit detection works the same way as the Claude CLI backend.
 */
async function runViaCLI(
  cliName: string,
  cliArgs: string[],
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  agentLabel: string,
  onLog: (msg: string) => void,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt(project, taskId, task)
  const userPrompt = `${systemPrompt}\n\n---\n\nStart working on [${taskId}]: ${task.title}\n\nRead relevant files first, then implement, test, and commit. Mark the task done in MANIFEST.json when finished.`

  onLog(`\n${agentLabel} agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Repo: ${project.repoPath}`)
  onLog(`   Backend: ${cliName}`)
  onLog(`   Timeout: ${Math.round(timeoutMs / 60000)}m`)

  const logFile = agentLogPath(project.name, project.repoPath)
  const ts = () => new Date().toISOString().slice(11, 19)
  const startMs = Date.now()
  writeLog(logFile, `[${ts()}] AAHP START  ${taskId} · ${task.title}\n`)
  writeLog(logFile, `[${ts()}] BACKEND     ${cliName} · timeout ${Math.round(timeoutMs / 60000)}m\n`)
  if (task.github_issue) writeLog(logFile, `[${ts()}] ISSUE       #${task.github_issue} in ${task.github_repo}\n`)
  writeLog(logFile, `${'─'.repeat(60)}\n`)

  const headBefore = await getHead(project.repoPath)

  let output = ''
  let exitCode: number | null = null
  let resMonitor: ResourceMonitor | undefined
  let aborted = false

  await new Promise<void>((resolve) => {
    const proc = spawn(cliName, cliArgs, {
      cwd: project.repoPath,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (proc.pid) {
      resMonitor = new ResourceMonitor(proc.pid)
      resMonitor.start()
    }

    const timer = setTimeout(() => {
      onLog(`\n${cliName} timed out after ${timeoutMs / 1000}s - sending SIGTERM`)
      proc.kill('SIGTERM')
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000)
    }, timeoutMs)

    // External abort hook (issue #28) - SIGTERM then SIGKILL after 5s
    const abortHandler = () => {
      aborted = true
      onLog(`\n${cliName} aborted by control endpoint - sending SIGTERM`)
      try { proc.kill('SIGTERM') } catch { /* already exited */ }
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000)
    }
    if (abortSignal) {
      if (abortSignal.aborted) abortHandler()
      else abortSignal.addEventListener('abort', abortHandler, { once: true })
    }

    proc.stdin.write(userPrompt)
    proc.stdin.end()

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      writeLog(logFile, text)
      onLog(text)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      writeLog(logFile, chunk.toString())
      onLog(chunk.toString())
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', abortHandler)
      resMonitor?.stop()
      exitCode = code
      if (code !== 0 && !aborted) onLog(`\n${cliName} exited with code ${code}`)
      resolve()
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', abortHandler)
      resMonitor?.stop()
      onLog(`\nspawn error: ${err.message}`)
      resolve()
    })
  })

  writeLog(logFile, `\n${'─'.repeat(60)}\n`)

  let committed = false
  try {
    const headAfter = await getHead(project.repoPath)
    committed = headAfter !== headBefore && headAfter.length > 0
  } catch {
    committed = output.toLowerCase().includes('git commit') ||
      output.toLowerCase().includes('committed') ||
      output.toLowerCase().includes('[main ') ||
      output.toLowerCase().includes('[master ')
  }

  if (committed && !aborted) {
    markTaskDone(project, taskId, task, 1, agentLabel)
    onLog(`\nMANIFEST.json updated - [${taskId}] marked done`)
  }

  const cliRunStatus = aborted ? 'ABORT ' : (committed ? 'DONE  ' : 'FAILED')
  writeLog(logFile, `[${ts()}] AAHP ${cliRunStatus}  ${taskId} · committed:${committed} · ${Math.round((Date.now() - startMs) / 1000)}s\n`)

  return {
    success: committed && !aborted,
    taskId,
    turns: 1,
    committed,
    summary: output.slice(0, 300),
    logFile,
    cpuAvg: resMonitor?.avgCpu(),
    memPeakMB: resMonitor?.peakMemMB(),
    aborted: aborted || undefined,
  }
}

/**
 * Run agent via Gemini CLI.
 * Uses `-p "" --approval-mode yolo` for headless/non-interactive mode.
 * Prompt is delivered via stdin (avoids agentic @file mode which causes hangs).
 */
async function runViaGeminiCLI(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  onLog: (msg: string) => void,
  timeoutMs: number = 10 * 60 * 1000,
  model: string = 'gemini-3.1-pro',
  abortSignal?: AbortSignal
): Promise<AgentResult> {
  // -p "" triggers headless mode; actual prompt arrives on stdin
  const args = ['-m', model, '-p', '', '--approval-mode', 'yolo']
  return runViaCLI('gemini', args, project, taskId, task, `Gemini/${model}`, onLog, timeoutMs, abortSignal)
}

/**
 * Run agent via OpenAI Codex CLI.
 * Uses `exec --full-auto` for non-interactive mode with prompt via stdin.
 */
async function runViaCodexCLI(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  onLog: (msg: string) => void,
  timeoutMs: number = 10 * 60 * 1000,
  model: string = 'gpt-5.5',
  abortSignal?: AbortSignal
): Promise<AgentResult> {
  const args = ['exec', '--model', model, '--full-auto']
  return runViaCLI('codex', args, project, taskId, task, `Codex/${model}`, onLog, timeoutMs, abortSignal)
}

/** Run agent via Anthropic SDK(direct API key) - fallback if claude CLI not available */
async function runViaSDK(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  apiKey: string,
  onLog: (msg: string) => void,
  timeoutMs: number = 10 * 60 * 1000,
  model: string = 'claude-opus-4-7',
  abortSignal?: AbortSignal
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
  let timedOut = false
  let aborted = false
  const deadline = Date.now() + timeoutMs

  const logFile = agentLogPath(project.name, project.repoPath)
  const ts = () => new Date().toISOString().slice(11, 19)
  const startMs = Date.now()
  writeLog(logFile, `[${ts()}] AAHP START  ${taskId} · ${task.title}\n`)
  writeLog(logFile, `[${ts()}] BACKEND     sdk · timeout ${Math.round(timeoutMs / 60000)}m\n`)
  if (task.github_issue) writeLog(logFile, `[${ts()}] ISSUE       #${task.github_issue} in ${task.github_repo}\n`)
  writeLog(logFile, `${'─'.repeat(60)}\n`)

  onLog(`\nSDK agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Backend: Anthropic SDK (API key)`)
  onLog(`   Timeout: ${Math.round(timeoutMs / 60000)}m`)

  while (turns < MAX_TURNS) {
    if (Date.now() >= deadline) {
      onLog(`\nSDK agent timed out after ${Math.round(timeoutMs / 60000)}m`)
      timedOut = true
      break
    }
    if (abortSignal?.aborted) {
      onLog(`\nSDK agent aborted by control endpoint`)
      aborted = true
      break
    }

    turns++
    onLog(`\n-- Turn ${turns}/${MAX_TURNS} --`)

    let response: any
    try {
      response = await (client.messages as any).create({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        tools: TOOL_DEFINITIONS,
        messages,
      }, abortSignal ? { signal: abortSignal } : undefined)
    } catch (err) {
      if (abortSignal?.aborted) {
        onLog(`\nSDK agent aborted by control endpoint`)
        aborted = true
        break
      }
      throw err
    }

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        onLog(`\n${block.text}`)
        finalSummary = block.text
      }
    }

    if (response.stop_reason === 'end_turn') { onLog('\nAgent finished.'); break }
    if (response.stop_reason !== 'tool_use') break

    const toolResults: any[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      onLog(`\nTool: ${block.name}`)
      const result = await executeTool(block.name, block.input as Record<string, string>, project.repoPath, onLog)
      if (block.name === 'git_commit' && result.startsWith('OK:')) committed = true
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }

    messages.push({ role: 'assistant' as const, content: response.content })
    messages.push({ role: 'user' as const, content: toolResults })
  }

  if (committed) {
    markTaskDone(project, taskId, task, turns, model)
    onLog(`\nMANIFEST.json updated - [${taskId}] marked done`)
  }
  if (timedOut) onLog(`\nAgent was stopped due to timeout after ${turns} turns`)

  writeLog(logFile, `\n${'─'.repeat(60)}\n`)
  const sdkStatus = aborted ? 'ABORT ' : (committed ? 'DONE  ' : 'FAILED')
  writeLog(logFile, `[${ts()}] AAHP ${sdkStatus}  ${taskId} · committed:${committed} · ${Math.round((Date.now() - startMs) / 1000)}s\n`)

  return {
    success: committed && !aborted,
    taskId, turns, committed, summary: finalSummary.slice(0, 200), logFile,
    aborted: aborted || undefined,
  }
}

// ── GitHub Copilot backend (via GitHub Copilot API - OpenAI-compatible) ──────

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
  onLog: (msg: string) => void,
  timeoutMs: number = 10 * 60 * 1000,
  abortSignal?: AbortSignal
): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt(project, taskId, task)
  const logFile = agentLogPath(project.name, project.repoPath)
  const MAX_TURNS = 30
  const COPILOT_ENDPOINT = 'https://api.githubcopilot.com/chat/completions'
  const MODEL = 'gpt-4o'
  const ts = () => new Date().toISOString().slice(11, 19)
  const startMs = Date.now()
  writeLog(logFile, `[${ts()}] AAHP START  ${taskId} · ${task.title}\n`)
  writeLog(logFile, `[${ts()}] BACKEND     copilot/${MODEL} · timeout ${Math.round(timeoutMs / 60000)}m\n`)
  if (task.github_issue) writeLog(logFile, `[${ts()}] ISSUE       #${task.github_issue} in ${task.github_repo}\n`)
  writeLog(logFile, `${'─'.repeat(60)}\n`)

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
  let timedOut = false
  let aborted = false
  const deadline = Date.now() + timeoutMs

  onLog(`\nGitHub Copilot agent starting on [${taskId}]: ${task.title}`)
  onLog(`   Backend: GitHub Copilot (${MODEL})`)
  onLog(`   Repo: ${project.repoPath}`)
  onLog(`   Timeout: ${Math.round(timeoutMs / 60000)}m`)

  while (turns < MAX_TURNS) {
    if (Date.now() >= deadline) {
      onLog(`\nCopilot agent timed out after ${Math.round(timeoutMs / 60000)}m`)
      timedOut = true
      break
    }
    if (abortSignal?.aborted) {
      onLog(`\nCopilot agent aborted by control endpoint`)
      aborted = true
      break
    }

    turns++
    onLog(`\n-- Turn ${turns}/${MAX_TURNS} --`)

    const ac = new AbortController()
    // Per-request timeout: remaining wall-clock time, capped at 2 minutes per request
    const perRequestMs = Math.min(deadline - Date.now(), 2 * 60 * 1000)
    const reqTimer = setTimeout(() => ac.abort(), perRequestMs)
    // Forward external abort (issue #28) to the in-flight HTTP request
    const externalAbortHandler = () => ac.abort()
    if (abortSignal) abortSignal.addEventListener('abort', externalAbortHandler, { once: true })

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
        signal: ac.signal,
      })
    } catch (err) {
      clearTimeout(reqTimer)
      if (abortSignal) abortSignal.removeEventListener('abort', externalAbortHandler)
      if (ac.signal.aborted) {
        if (abortSignal?.aborted) {
          onLog(`\nCopilot agent aborted by control endpoint`)
          aborted = true
        } else {
          onLog(`\nCopilot request aborted (timeout)`)
          timedOut = true
        }
        break
      }
      onLog(`\nNetwork error: ${String(err)}`)
      break
    }
    clearTimeout(reqTimer)
    if (abortSignal) abortSignal.removeEventListener('abort', externalAbortHandler)

    if (!response.ok) {
      const body = await response.text()
      onLog(`\nCopilot API error ${response.status}: ${body.slice(0, 200)}`)
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
      onLog('\nCopilot agent finished.')
      break
    }

    // Execute tool calls
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls })

    for (const call of msg.tool_calls) {
      if (Date.now() >= deadline) { timedOut = true; break }

      const fnName: string = call.function.name
      let fnArgs: Record<string, string> = {}
      try { fnArgs = JSON.parse(call.function.arguments) } catch { /* use empty args */ }

      onLog(`\nTool: ${fnName}(${JSON.stringify(fnArgs).slice(0, 80)})`)
      const result = await executeTool(fnName, fnArgs, project.repoPath, onLog)
      onLog(`   -> ${result.slice(0, 120)}`)

      if (fnName === 'git_commit' && result.startsWith('OK:')) committed = true

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      })
    }
    if (timedOut) break
  }

  if (committed) {
    markTaskDone(project, taskId, task, turns, `github-copilot/${MODEL}`)
    onLog(`\nMANIFEST.json updated - [${taskId}] marked done`)
  }
  if (timedOut) onLog(`\nAgent was stopped due to timeout after ${turns} turns`)

  writeLog(logFile, `\n${'─'.repeat(60)}\n`)
  const copilotStatus = aborted ? 'ABORT ' : (committed ? 'DONE  ' : 'FAILED')
  writeLog(logFile, `[${ts()}] AAHP ${copilotStatus}  ${taskId} · committed:${committed} · ${Math.round((Date.now() - startMs) / 1000)}s\n`)

  return {
    success: committed && !aborted,
    taskId, turns, committed, summary: finalSummary.slice(0, 200), logFile,
    aborted: aborted || undefined,
  }
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

// ── Retry with exponential backoff ───────────────────────────────────────────

export interface RetryOptions {
  maxRetries?: number   // default 3
  baseDelayMs?: number  // default 1000
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
}

/**
 * Run an async function with exponential backoff retry on failure.
 * Retries only when the function throws or returns success=false.
 *
 * Delay schedule: baseDelayMs * 2^(attempt-1)  (1s, 2s, 4s by default)
 * Does NOT retry when no backend is available (throws immediately).
 */
export async function withRetry<T extends { success: boolean }>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 1000

  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn()
      if (result.success || attempt > maxRetries) return result

      // Non-throwing failure: treat as retryable
      if (attempt <= maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1)
        opts.onRetry?.(attempt, new Error('Agent returned success=false'), delayMs)
        await new Promise(r => setTimeout(r, delayMs))
      } else {
        return result
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Non-retryable errors: no backend available, auth errors
      const msg = lastError.message
      if (
        msg.includes('No agent backend') ||
        msg.includes('Claude Code CLI not found') ||
        msg.includes('GitHub Copilot token not found') ||
        msg.includes('token invalid or expired')
      ) {
        throw lastError
      }

      if (attempt > maxRetries) throw lastError

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1)
      opts.onRetry?.(attempt, lastError, delayMs)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }

  // Should never reach here but satisfy TypeScript
  if (lastError) throw lastError
  throw new Error('withRetry: unexpected exit')
}

/** Main entry point - selects backend based on explicit preference or auto-detection */
export async function runAgent(
  project: AahpProject,
  taskId: string,
  task: AahpTask,
  apiKey: string,
  onLog: (msg: string) => void,
  explicitBackend: 'auto' | 'claude' | 'gemini' | 'codex' | 'copilot' | 'sdk' = 'auto',
  timeoutMinutes: number = 10,
  retryOptions?: RetryOptions,
  model?: string,
  abortSignal?: AbortSignal
): Promise<AgentResult> {
  const { backend, copilotToken } = await resolveBackend(apiKey, explicitBackend)
  const timeoutMs = timeoutMinutes * 60 * 1000

  // backend === 'none' — throw immediately (non-retryable)
  if (backend === 'none') {
    const hint = explicitBackend === 'copilot'
      ? 'GitHub Copilot token not found. Make sure you are signed in: gh auth login'
      : explicitBackend === 'claude'
        ? 'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code'
        : explicitBackend === 'gemini'
          ? 'Gemini CLI not found. Install it with: npm install -g @google/gemini-cli'
          : explicitBackend === 'codex'
            ? 'Codex CLI not found. Install it with: npm install -g @openai/codex'
            : 'No agent backend available.\n' +
              '  Option 1: npm install -g @anthropic-ai/claude-code  (Claude Code CLI)\n' +
              '  Option 2: npm install -g @google/gemini-cli          (Gemini CLI)\n' +
              '  Option 3: npm install -g @openai/codex               (Codex CLI)\n' +
              '  Option 4: gh auth login                               (GitHub Copilot)\n' +
              '  Option 5: aahp config --api-key "sk-ant-..."          (Anthropic API key)'
    throw new Error(hint)
  }

  const run = (): Promise<AgentResult> => {
    if (backend === 'claude-cli') return runViaClaudeCLI(project, taskId, task, onLog, timeoutMs, abortSignal)
    if (backend === 'gemini')     return runViaGeminiCLI(project, taskId, task, onLog, timeoutMs, model, abortSignal)
    if (backend === 'codex')      return runViaCodexCLI(project, taskId, task, onLog, timeoutMs, model, abortSignal)
    if (backend === 'copilot')    return runViaCopilot(project, taskId, task, copilotToken, onLog, timeoutMs, abortSignal)
    return runViaSDK(project, taskId, task, apiKey, onLog, timeoutMs, model, abortSignal)
  }

  if (!retryOptions) return run()
  return withRetry(run, {
    ...retryOptions,
    onRetry: (attempt, err, delay) => {
      onLog(`\n[retry] attempt ${attempt} failed (${err.message.slice(0, 80)}) — retrying in ${delay}ms`)
      retryOptions.onRetry?.(attempt, err, delay)
    },
  })
}

export interface PlanningResult {
  success: boolean
  output: string
  logFile: string
}

/**
 * Run a planning-only agent on a project.
 * The agent analyzes the repo and writes NEXT_ACTIONS.md with new tasks.
 * It does NOT execute code and does NOT commit. No task is marked done.
 * Call scanProjectByPath() after this to pick up the new tasks.
 */
export async function runPlanningAgent(
  project: AahpProject,
  apiKey: string,
  onLog: (msg: string) => void,
  explicitBackend: 'auto' | 'claude' | 'gemini' | 'codex' | 'copilot' | 'sdk' = 'auto',
  timeoutMinutes: number = 5,
  model?: string
): Promise<PlanningResult> {
  const { backend, copilotToken } = await resolveBackend(apiKey, explicitBackend)
  const timeoutMs = timeoutMinutes * 60 * 1000
  const prompt = buildPlanningPrompt(project)
  const logFile = agentLogPath(`${project.name}-plan`, project.repoPath)

  const ts = () => new Date().toISOString().slice(11, 19)
  const startMs = Date.now()
  writeLog(logFile, `[${ts()}] AAHP PLAN   ${project.name}\n`)
  writeLog(logFile, `[${ts()}] BACKEND     ${backend} · timeout ${timeoutMinutes}m\n`)
  writeLog(logFile, `${'─'.repeat(60)}\n`)

  onLog(`\n📐 Planning agent starting on ${project.name}`)
  onLog(`   Backend: ${backend}`)
  onLog(`   Timeout: ${timeoutMinutes}m`)

  if (backend === 'none') {
    const msg = 'No agent backend available for planning. Install Claude Code, Gemini CLI, Codex CLI or run: gh auth login'
    onLog(`\n❌ ${msg}`)
    return { success: false, output: msg, logFile }
  }

  let output = ''

  if (backend === 'gemini') {
    // Gemini CLI planning: same stdin pattern, -p "" for headless mode
    await new Promise<void>((resolve) => {
      const proc = spawn('gemini', ['-m', model ?? 'gemini-3.1-pro', '-p', '', '--approval-mode', 'yolo'],
        { cwd: project.repoPath, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { proc.kill('SIGTERM') }, timeoutMs)
      proc.stdin.write(prompt)
      proc.stdin.end()
      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        writeLog(logFile, text)
        onLog(text)
      })
      proc.stderr.on('data', (chunk: Buffer) => writeLog(logFile, chunk.toString()))
      proc.on('close', () => { clearTimeout(timer); resolve() })
      proc.on('error', (err) => { clearTimeout(timer); onLog(`spawn error: ${err.message}`); resolve() })
    })
  } else if (backend === 'codex') {
    // Codex CLI planning: exec --full-auto with prompt via stdin
    await new Promise<void>((resolve) => {
      const proc = spawn('codex', ['exec', '--model', model ?? 'gpt-5.5', '--full-auto'],
        { cwd: project.repoPath, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { proc.kill('SIGTERM') }, timeoutMs)
      proc.stdin.write(prompt)
      proc.stdin.end()
      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        writeLog(logFile, text)
        onLog(text)
      })
      proc.stderr.on('data', (chunk: Buffer) => writeLog(logFile, chunk.toString()))
      proc.on('close', () => { clearTimeout(timer); resolve() })
      proc.on('error', (err) => { clearTimeout(timer); onLog(`spawn error: ${err.message}`); resolve() })
    })
  } else if (backend === 'claude-cli') {
    const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'
    await new Promise<void>((resolve) => {
      const proc = spawn(
        claudeCmd,
        ['--print', '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep', '--output-format', 'text'],
        { cwd: project.repoPath, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] }
      )
      const timer = setTimeout(() => { proc.kill('SIGTERM') }, timeoutMs)
      proc.stdin.write(prompt)
      proc.stdin.end()
      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        writeLog(logFile, text)
        onLog(text)
      })
      proc.stderr.on('data', (chunk: Buffer) => writeLog(logFile, chunk.toString()))
      proc.on('close', () => { clearTimeout(timer); resolve() })
      proc.on('error', (err) => { clearTimeout(timer); onLog(`spawn error: ${err.message}`); resolve() })
    })
  } else if (backend === 'copilot') {
    // Copilot via GitHub API (same model as runViaCopilot but with planning prompt)
    const messages = [{ role: 'user', content: prompt }]
    const MODEL = 'gpt-4o'
    try {
      const response = await fetch('https://api.githubcopilot.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${copilotToken}`, 'Content-Type': 'application/json',
          'Copilot-Integration-Id': 'vscode-chat', 'Editor-Version': 'vscode/1.95.3' },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 4000 }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const data = await response.json() as { choices?: Array<{ message: { content: string } }> }
      const text = data.choices?.[0]?.message?.content ?? ''
      output = text
      writeLog(logFile, text)
      onLog(text)
      // Write NEXT_ACTIONS.md from Copilot response (agent can't write files directly in SDK mode)
      const naMatch = text.match(/```[\w]*\n(# NEXT_ACTIONS[\s\S]*?)```/)
      if (naMatch?.[1]) {
        const naPath = path.join(project.handoffDir, 'NEXT_ACTIONS.md')
        fs.writeFileSync(naPath, naMatch[1].trim() + '\n', 'utf8')
        onLog(`\n📝 NEXT_ACTIONS.md written from Copilot planning response`)
      }
    } catch (err) {
      onLog(`\nCopilot planning error: ${(err as Error).message}`)
    }
  } else if (backend === 'sdk') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey })
    try {
      const msg = await client.messages.create({
        model: model ?? 'claude-opus-4-7',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      })
      const text = msg.content.filter((b: { type: string }) => b.type === 'text')
        .map((b: { type: string; text?: string }) => b.text ?? '').join('')
      output = text
      writeLog(logFile, text)
      onLog(text)
      // Extract and write NEXT_ACTIONS.md
      const naMatch = text.match(/```[\w]*\n(# NEXT_ACTIONS[\s\S]*?)```/)
      if (naMatch?.[1]) {
        const naPath = path.join(project.handoffDir, 'NEXT_ACTIONS.md')
        fs.writeFileSync(naPath, naMatch[1].trim() + '\n', 'utf8')
        onLog(`\n📝 NEXT_ACTIONS.md written from SDK planning response`)
      }
    } catch (err) {
      onLog(`\nSDK planning error: ${(err as Error).message}`)
    }
  }

  writeLog(logFile, `\n${'─'.repeat(60)}\n`)
  writeLog(logFile, `[${ts()}] PLAN ${output.length > 100 ? 'DONE  ' : 'EMPTY '}  ${project.name} · ${Math.round((Date.now() - startMs) / 1000)}s\n`)

  const success = output.length > 100
  if (success) onLog(`\n✅ Planning complete for ${project.name}`)
  return { success, output, logFile }
}
