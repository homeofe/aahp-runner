import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import type { AahpManifest, AahpProject, AahpTask } from './types.js'

interface GitHubIssue {
  number: number
  title: string
  body: string
  labels: Array<{ name: string }>
  state: 'open' | 'closed'
  stateReason?: 'completed' | 'not_planned' | 'reopened' | null
}

/** Detect owner/repo from git remote origin URL */
function detectGitHubRepo(repoPath: string): string | null {
  try {
    const url = execSync('git remote get-url origin', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim()
    // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
    const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)
    return match ? (match[1] ?? null) : null
  } catch {
    return null
  }
}

/** Map GitHub labels to AAHP task priority */
function labelsToPriority(labels: Array<{ name: string }>): AahpTask['priority'] {
  const names = labels.map(l => l.name.toLowerCase())
  if (names.some(n => n.includes('bug') || n.includes('critical') || n.includes('urgent'))) return 'high'
  if (names.some(n => n.includes('enhancement') || n.includes('feature') || n.includes('medium'))) return 'medium'
  return 'low'
}

/** Map GitHub issue state + labels to an AAHP task status.
 *  closed             → done
 *  open + wip/in-progress label → in_progress
 *  open + blocked/on-hold label → blocked
 *  open (default)     → ready */
function githubStateToAahpStatus(
  state: string,
  labels: Array<{ name: string }>
): AahpTask['status'] {
  if (state === 'closed') return 'done'
  const names = labels.map(l => l.name.toLowerCase())
  if (names.some(n => n.includes('in progress') || n.includes('in-progress') || n.includes('wip'))) return 'in_progress'
  if (names.some(n => n.includes('blocked') || n.includes('on hold') || n.includes('on-hold'))) return 'blocked'
  return 'ready'
}

function extractTaskIdFromIssueTitle(title: string): string | undefined {
  const match = title.match(/\b(T-\d{3,})\b/i)
  return match?.[1]?.toUpperCase()
}

/** Fetch GitHub issues (all states) and sync them into the manifest as AAHP tasks.
 *  - open issue  → creates or updates task, status derived from labels
 *  - closed issue → marks linked task as done
 *  Returns the (possibly updated) manifest. Writes to disk if anything changed. */
export function fetchAndImportGitHubIssues(
  repoPath: string,
  handoffDir: string,
  manifest: AahpManifest
): AahpManifest {
  const repo = detectGitHubRepo(repoPath)
  if (!repo) return manifest

  let issues: GitHubIssue[]
  try {
    const output = execSync(
      `gh issue list --repo ${repo} --state all --json number,title,body,labels,state,stateReason --limit 100`,
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
    ).toString()
    issues = JSON.parse(output) as GitHubIssue[]
  } catch {
    // gh not installed, not authenticated, or no GitHub remote - skip silently
    return manifest
  }

  if (!issues.length) return manifest

  const tasks = manifest.tasks ?? {}
  let nextId = manifest.next_task_id ?? (Object.keys(tasks).length + 1)
  let changed = false

  // Build a set of already-imported issue numbers
  const importedIssueNumbers = new Set(
    Object.values(tasks)
      .map(t => t.github_issue)
      .filter((n): n is number => n !== undefined)
  )

  for (const issue of issues) {
    if (importedIssueNumbers.has(issue.number)) continue

    const githubStatus = githubStateToAahpStatus(issue.state, issue.labels)

    const existingTaskId = extractTaskIdFromIssueTitle(issue.title)
    if (existingTaskId && tasks[existingTaskId]) {
      const existingTask = tasks[existingTaskId]!
      let taskChanged = false

      if (existingTask.github_issue !== issue.number || existingTask.github_repo !== repo) {
        existingTask.github_issue = issue.number
        existingTask.github_repo = repo
        taskChanged = true
      }

      // Sync status from GitHub:
      // - closed issue always wins (mark done)
      // - open issue updates status unless the agent is actively working (in_progress)
      const shouldSyncStatus =
        githubStatus === 'done' || existingTask.status !== 'in_progress'
      if (shouldSyncStatus && existingTask.status !== githubStatus) {
        existingTask.status = githubStatus
        taskChanged = true
      }

      if (taskChanged) changed = true
      importedIssueNumbers.add(issue.number)
      continue
    }

    // Don't create new tasks for already-closed issues with no matching T-xxx task
    if (issue.state === 'closed') continue

    const taskId = `T-${String(nextId).padStart(3, '0')}`
    tasks[taskId] = {
      title: issue.title,
      status: githubStatus,
      priority: labelsToPriority(issue.labels),
      depends_on: [],
      created: new Date().toISOString(),
      notes: issue.body ? issue.body.slice(0, 500) : undefined,
      github_issue: issue.number,
      github_repo: repo,
    }
    nextId++
    changed = true
  }

  if (!changed) return manifest

  const updated: AahpManifest = { ...manifest, tasks, next_task_id: nextId }
  const manifestPath = path.join(handoffDir, 'MANIFEST.json')
  fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2) + '\n', 'utf8')
  return updated
}

export function scanProjects(rootDir: string): AahpProject[] {
  const projects: AahpProject[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return projects
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const repoPath = path.join(rootDir, entry.name)
    const handoffDir = path.join(repoPath, '.ai', 'handoff')
    const manifestPath = path.join(handoffDir, 'MANIFEST.json')

    if (!fs.existsSync(manifestPath)) continue

    let manifest: AahpManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AahpManifest
    } catch {
      continue
    }

    // Fetch open GitHub issues and import any new ones as ready tasks
    manifest = fetchAndImportGitHubIssues(repoPath, handoffDir, manifest)

    const tasks = manifest.tasks ?? {}
    const readyTasks = Object.entries(tasks).filter(
      ([, t]) => t.status === 'ready'
    ) as Array<[string, AahpTask]>
    const activeTasks = Object.entries(tasks).filter(
      ([, t]) => t.status === 'in_progress'
    ) as Array<[string, AahpTask]>

    projects.push({
      name: manifest.project || entry.name,
      repoPath,
      handoffDir,
      manifest,
      readyTasks,
      activeTasks,
    })
  }

  return projects.sort((a, b) => {
    // Sort: active first, then by number of ready tasks
    const aScore = a.activeTasks.length * 10 + a.readyTasks.length
    const bScore = b.activeTasks.length * 10 + b.readyTasks.length
    return bScore - aScore
  })
}

export function scanProjectByPath(repoPath: string): AahpProject | undefined {
  const handoffDir = path.join(repoPath, '.ai', 'handoff')
  const manifestPath = path.join(handoffDir, 'MANIFEST.json')
  if (!fs.existsSync(manifestPath)) return undefined

  let manifest: AahpManifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AahpManifest
  } catch {
    return undefined
  }

  manifest = fetchAndImportGitHubIssues(repoPath, handoffDir, manifest)

  const tasks = manifest.tasks ?? {}
  const readyTasks = Object.entries(tasks).filter(
    ([, t]) => t.status === 'ready'
  ) as Array<[string, AahpTask]>
  const activeTasks = Object.entries(tasks).filter(
    ([, t]) => t.status === 'in_progress'
  ) as Array<[string, AahpTask]>

  return {
    name: manifest.project || path.basename(repoPath),
    repoPath,
    handoffDir,
    manifest,
    readyTasks,
    activeTasks,
  }
}

export function getTopTask(project: AahpProject): [string, AahpTask] | undefined {
  if (project.activeTasks.length > 0) return project.activeTasks[0]
  if (project.readyTasks.length > 0) return project.readyTasks[0]
  return undefined
}

export function readHandoffFile(project: AahpProject, name: string): string {
  const p = path.join(project.handoffDir, name)
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    // Return empty string on any error (missing file, permission denied, etc.)
    return ''
  }
}

export function buildSystemPrompt(project: AahpProject, taskId: string, task: AahpTask): string {
  const m = project.manifest
  const conventions = readHandoffFile(project, 'CONVENTIONS.md')
  const trust = readHandoffFile(project, 'TRUST.md')
  const status = readHandoffFile(project, 'STATUS.md')

  const openTasks = Object.entries(m.tasks ?? {})
    .filter(([, t]) => t.status !== 'done')
    .map(([id, t]) => `  ${id} [${t.status}/${t.priority}]: ${t.title}`)
    .join('\n')

  return [
    `## AAHP v3 Context - ${m.project}`,
    `Phase: ${m.last_session.phase}`,
    `Last agent: ${m.last_session.agent} @ ${m.last_session.timestamp}`,
    `Last commit: ${m.last_session.commit}`,
    ``,
    `### Quick Context`,
    m.quick_context,
    ``,
    `### Your Task: [${taskId}] ${task.title}`,
    `Priority: ${task.priority} | Status: ${task.status}`,
    task.depends_on?.length ? `Depends on: ${task.depends_on.join(', ')}` : '',
    task.github_issue ? `GitHub Issue: #${task.github_issue} in ${task.github_repo}` : '',
    task.notes ? `\nIssue description:\n${task.notes}` : '',
    ``,
    `### All Open Tasks`,
    openTasks,
    ``,
    conventions ? `### Conventions\n${conventions.split('\n').slice(0, 60).join('\n')}` : '',
    trust ? `### Trust State\n${trust.split('\n').slice(0, 20).join('\n')}` : '',
    status ? `### Current Status\n${status.split('\n').slice(0, 30).join('\n')}` : '',
    ``,
    `---`,
    `You are an autonomous agent working on the task above. Use the tools available to:`,
    `1. Read relevant files to understand the codebase`,
    `2. Make the necessary changes`,
    `3. Run tests/builds to verify`,
    `4. Commit your changes with a conventional commit message`,
    `5. Update MANIFEST.json: mark [${taskId}] as done, update quick_context, last_session`,
    `   Also unblock any tasks whose depends_on are now all done (change status blocked -> ready).`,
    task.github_issue
      ? `   Then close GitHub issue #${task.github_issue}: run \`gh issue close ${task.github_issue} --repo ${task.github_repo} --comment "Resolved in [commit hash] via AAHP task ${taskId}"\``
      : '',
    `6. Regenerate .ai/handoff/NEXT_ACTIONS.md to reflect the CURRENT state of all tasks:`,
    `   - Top section: Status Summary table (Done | Ready | Blocked counts)`,
    `   - Section "## ⚡ Ready - Work These Next": all tasks with status=ready, sorted high>medium>low priority`,
    `   - Section "## 🚫 Blocked": all tasks with status=blocked, each showing what it's blocked_by`,
    `   - Section "## ✅ Recently Completed": last 5 done tasks with date`,
    `   Each ready/blocked task must have Goal, Context, What to do, Files, Definition of done.`,
    ``,
    `Work directory: ${project.repoPath}`,
    `Do NOT ask questions. Act autonomously based on the context above.`,
  ].filter(Boolean).join('\n')
}

export function saveManifest(project: AahpProject, manifest: AahpManifest): void {
  const p = path.join(project.handoffDir, 'MANIFEST.json')
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}
