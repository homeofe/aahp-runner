import * as fs from 'fs'
import * as path from 'path'
import os from 'os'
import { execSync, spawnSync } from 'child_process'
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

/** Normalize a task/issue title for fuzzy matching: lowercase, strip T-NNN prefix,
 *  strip "(issue #N)" annotations, collapse non-alphanumeric runs to spaces. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\[T-\d+\]\s*/i, '')
    .replace(/\(issue #\d+\)/gi, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Safely extract issue number from a github_issue value that may be a legacy URL string. */
function extractIssueNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && raw > 0) return raw
  if (typeof raw === 'string' && raw) {
    const m = raw.match(/\/issues\/(\d+)$/)
    if (m?.[1]) return parseInt(m[1], 10)
  }
  return undefined
}

// Labels applied to GitHub issues created from AAHP tasks
const PRIORITY_LABELS: Record<string, { name: string; color: string }> = {
  high:   { name: 'priority: high',   color: 'd93f0b' },
  medium: { name: 'priority: medium', color: 'fbca04' },
  low:    { name: 'priority: low',    color: '0075ca' },
}
const STATUS_LABELS: Record<string, { name: string; color: string }> = {
  blocked:     { name: 'blocked',      color: 'e4e669' },
  in_progress: { name: 'in progress',  color: '0052cc' },
}

/** Create a GitHub label if it doesn't exist yet (--force updates existing). */
function ensureLabel(repo: string, name: string, color: string, cwd: string): void {
  try {
    execSync(`gh label create "${name}" --color "${color}" --force --repo ${repo}`,
      { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 })
  } catch { /* best-effort */ }
}

/** For every actionable task that has no GitHub issue, create one and link it back.
 *  Writes MANIFEST.json if any issues were created. Returns updated manifest. */
export function createMissingGitHubIssues(
  repoPath: string,
  handoffDir: string,
  manifest: AahpManifest
): AahpManifest {
  const repo = detectGitHubRepo(repoPath)
  if (!repo) return manifest

  const tasks = manifest.tasks ?? {}
  const toCreate = Object.entries(tasks).filter(
    ([, t]) => !t.github_issue &&
      (t.status === 'ready' || t.status === 'in_progress' || t.status === 'blocked')
  ) as Array<[string, AahpTask]>

  if (toCreate.length === 0) return manifest

  // Ensure all needed labels exist before creating issues
  const labelsNeeded = new Set(toCreate.flatMap(([, t]) => [t.priority, t.status]))
  for (const key of labelsNeeded) {
    const lbl = PRIORITY_LABELS[key] ?? STATUS_LABELS[key]
    if (lbl) ensureLabel(repo, lbl.name, lbl.color, repoPath)
  }

  let changed = false
  for (const [taskId, task] of toCreate) {
    const title = `[${taskId}] ${task.title}`
    const labelArgs = [
      ...(PRIORITY_LABELS[task.priority] ? ['--label', PRIORITY_LABELS[task.priority]!.name] : []),
      ...(STATUS_LABELS[task.status]     ? ['--label', STATUS_LABELS[task.status]!.name]     : []),
    ]
    const body = [
      `**AAHP Task:** \`${taskId}\`  `,
      `**Status:** ${task.status}  `,
      `**Priority:** ${task.priority}  `,
      task.depends_on?.length ? `**Depends on:** ${task.depends_on.join(', ')}  ` : '',
      '',
      task.notes ?? '',
      '',
      `---`,
      `*Auto-created from AAHP manifest · project: ${manifest.project}*`,
    ].filter(l => l !== undefined).join('\n').trim()

    // Write body to a temp file to avoid shell-escaping issues cross-platform
    const tmpFile = path.join(os.tmpdir(), `aahp-issue-${taskId}-${Date.now()}.md`)
    try {
      fs.writeFileSync(tmpFile, body, 'utf8')
      const result = spawnSync('gh', [
        'issue', 'create',
        '--repo', repo,
        '--title', title,
        '--body-file', tmpFile,
        ...labelArgs,
      ], { cwd: repoPath, timeout: 15000, encoding: 'utf8' })

      if (result.status === 0 && result.stdout) {
        // gh outputs the issue URL: https://github.com/owner/repo/issues/42
        const numMatch = result.stdout.trim().match(/\/issues\/(\d+)$/)
        if (numMatch?.[1]) {
          task.github_issue = parseInt(numMatch[1], 10)
          task.github_repo = repo
          changed = true
        }
      }
    } catch { /* best-effort */ } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  }

  if (!changed) return manifest
  const updated: AahpManifest = { ...manifest, tasks }
  fs.writeFileSync(path.join(handoffDir, 'MANIFEST.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')
  return updated
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

  // Migration: normalize any legacy string URL github_issue values to plain numbers
  for (const task of Object.values(tasks)) {
    if (typeof (task.github_issue as unknown) === 'string') {
      const num = extractIssueNumber(task.github_issue)
      if (num !== undefined) {
        task.github_issue = num
        changed = true
      } else {
        delete task.github_issue
        changed = true
      }
    }
  }

  // Build a set of already-imported issue numbers
  const importedIssueNumbers = new Set(
    Object.values(tasks)
      .map(t => t.github_issue)
      .filter((n): n is number => typeof n === 'number')
  )

  // Reverse map: issue number → taskId, for updating status when issues are closed
  const issueNumToTaskId = new Map(
    Object.entries(tasks)
      .filter(([, t]) => typeof t.github_issue === 'number')
      .map(([id, t]) => [t.github_issue as number, id])
  )

  // Build a normalized-title → taskId lookup for title-based fallback matching
  const titleToTaskId = new Map(
    Object.entries(tasks)
      .filter(([, t]) => !t.github_issue)
      .map(([id, t]) => [normalizeTitle(t.title), id])
  )

  for (const issue of issues) {
    const githubStatus = githubStateToAahpStatus(issue.state, issue.labels)

    if (importedIssueNumbers.has(issue.number)) {
      // Already linked - check if the GitHub issue was closed and task needs status update
      const linkedId = issueNumToTaskId.get(issue.number)
      if (linkedId && tasks[linkedId] && issue.state === 'closed' && tasks[linkedId]!.status !== 'done') {
        tasks[linkedId]!.status = 'done'
        if (!tasks[linkedId]!.completed) tasks[linkedId]!.completed = new Date().toISOString()
        changed = true
      }
      continue
    }

    // 1. Match by T-NNN embedded in the issue title
    const existingTaskId = extractTaskIdFromIssueTitle(issue.title)
    if (existingTaskId && tasks[existingTaskId]) {
      const existingTask = tasks[existingTaskId]!
      let taskChanged = false

      if (existingTask.github_issue !== issue.number || existingTask.github_repo !== repo) {
        existingTask.github_issue = issue.number
        existingTask.github_repo = repo
        taskChanged = true
      }

      const shouldSyncStatus = githubStatus === 'done' || existingTask.status !== 'in_progress'
      if (shouldSyncStatus && existingTask.status !== githubStatus) {
        existingTask.status = githubStatus
        taskChanged = true
      }

      if (taskChanged) changed = true
      importedIssueNumbers.add(issue.number)
      continue
    }

    // 2. Fallback: match by normalized title (handles old manually-created issues)
    const normalizedIssueTitle = normalizeTitle(issue.title)
    const titleMatchId = titleToTaskId.get(normalizedIssueTitle)
    if (titleMatchId && tasks[titleMatchId]) {
      const existingTask = tasks[titleMatchId]!
      existingTask.github_issue = issue.number
      existingTask.github_repo = repo
      const shouldSyncStatus = githubStatus === 'done' || existingTask.status !== 'in_progress'
      if (shouldSyncStatus && existingTask.status !== githubStatus) existingTask.status = githubStatus
      titleToTaskId.delete(normalizedIssueTitle)
      importedIssueNumbers.add(issue.number)
      changed = true
      continue
    }

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

/** Parse a NEXT_ACTIONS.md file and extract actionable task items.
 *  Returns items as { section, taskId?, title, priority? } - minimal subset needed here. */
function parseNextActionsBasic(markdown: string): Array<{ section: string; taskId?: string; title: string; priority?: string }> {
  const items: Array<{ section: string; taskId?: string; title: string; priority?: string }> = []
  let section = 'unknown'
  let insideTaskBlock = false  // true when inside a ### heading task block (sub-items are DOD, not tasks)

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const headingLevel = trimmed.match(/^(#{1,6})\s+/)
    if (headingLevel) {
      const level = headingLevel[1]!.length
      const rest = trimmed.slice(level).trim()
      const h = rest.toLowerCase().replace(/[^\x20-\x7E]/g, '').trim()

      if (level <= 2) {
        // ## section heading - update section and exit any task block
        insideTaskBlock = false
        if (/ready|work these next|next step|open task/i.test(h)) section = 'ready'
        else if (/in.?progress|active|running|current/i.test(h)) section = 'in_progress'
        else if (/blocked|cannot start/i.test(h)) section = 'blocked'
        else if (/done|completed|recently completed/i.test(h)) section = 'done'
      } else {
        // ### (or deeper) heading - this is a task entry, enter task block
        insideTaskBlock = true
        const taskH = trimmed.match(/^#{2,3}\s+(?:~~)?(?:(T-\d+)[:\s]+)?(.+?)(?:~~)?\s*$/)
        if (taskH?.[2]) {
          const title = taskH[2].replace(/\*+/g, '').trim()
          if (title && title.length >= 8 && !/^(ready|blocked|done|in.?progress|recently completed|status summary|open tasks?)/i.test(title)) {
            if (section !== 'done') items.push({ section, taskId: taskH[1]?.toUpperCase(), title })
          }
        }
      }
      continue
    }

    if (section === 'done' || section === 'unknown') continue
    // Skip checkboxes that are inside a task block (they are Definition of Done / acceptance criteria)
    if (insideTaskBlock) continue

    // Checkbox: - [ ] title or - [x] title (only at section level, not inside a task block)
    const check = trimmed.match(/^-\s+\[([ xX])\]\s+(.+)/)
    if (check?.[2]) {
      const done = check[1]?.toLowerCase() === 'x'
      if (!done) {
        const title = check[2].replace(/\*+/g, '').replace(/\(?(high|medium|low)\s*priority\)?/i, '').trim()
        const pri = check[2].match(/\(?(high|medium|low)\s*priority\)?/i)?.[1]?.toLowerCase()
        if (title.length >= 8) items.push({ section, title, ...(pri ? { priority: pri } : {}) })
      }
    }
  }
  return items
}

/** Normalize a title for comparison (same as in aahp-reader). */
function normTitle(title: string): string {
  return title.toLowerCase().replace(/^\[T-\d+\]\s*/i, '').replace(/\(issue #\d+\)/gi, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Ensure every actionable NEXT_ACTIONS item has a MANIFEST task entry.
 *  Agents using pure AAHP protocol may write NEXT_ACTIONS.md without touching
 *  MANIFEST - this bridges that gap so createMissingGitHubIssues can then create
 *  GitHub issues for all of them. */
export function syncNextActionsToManifest(
  repoPath: string,
  handoffDir: string,
  manifest: AahpManifest
): AahpManifest {
  const nextActionsMd = (() => {
    try { return fs.readFileSync(path.join(handoffDir, 'NEXT_ACTIONS.md'), 'utf8') } catch { return null }
  })()
  if (!nextActionsMd) return manifest

  const items = parseNextActionsBasic(nextActionsMd)
  const actionable = items.filter(i => i.section === 'ready' || i.section === 'in_progress' || i.section === 'blocked')
  if (actionable.length === 0) return manifest

  const tasks = manifest.tasks ?? {}
  let nextId = manifest.next_task_id ?? (Object.keys(tasks).length + 1)
  let changed = false
  const existingTitles = new Set(Object.values(tasks).map(t => normTitle(t.title)))

  for (const item of actionable) {
    if (item.taskId && tasks[item.taskId]) continue
    if (existingTitles.has(normTitle(item.title))) continue

    while (tasks[`T-${String(nextId).padStart(3, '0')}`]) nextId++
    const taskId = item.taskId ?? `T-${String(nextId).padStart(3, '0')}`

    const status: AahpTask['status'] =
      item.section === 'in_progress' ? 'in_progress' :
      item.section === 'blocked' ? 'blocked' : 'ready'
    const priority: AahpTask['priority'] =
      item.priority === 'high' ? 'high' : item.priority === 'low' ? 'low' : 'medium'

    tasks[taskId] = { title: item.title.trim(), status, priority, depends_on: [], created: new Date().toISOString() }
    existingTitles.add(normTitle(item.title))
    nextId++
    changed = true
  }

  if (!changed) return manifest
  const updated: AahpManifest = { ...manifest, tasks, next_task_id: nextId }
  fs.writeFileSync(path.join(handoffDir, 'MANIFEST.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')
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

    // Sync GitHub issues → MANIFEST, ensure NEXT_ACTIONS items have MANIFEST entries, then push unlinked tasks → GitHub
    manifest = fetchAndImportGitHubIssues(repoPath, handoffDir, manifest)
    manifest = syncNextActionsToManifest(repoPath, handoffDir, manifest)
    manifest = createMissingGitHubIssues(repoPath, handoffDir, manifest)

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
  manifest = syncNextActionsToManifest(repoPath, handoffDir, manifest)
  manifest = createMissingGitHubIssues(repoPath, handoffDir, manifest)

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
