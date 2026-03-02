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
export function detectGitHubRepo(repoPath: string): string | null {
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

/** Map GitHub labels to AAHP task priority.
 *  Returns undefined when no priority-related label is found (so callers can
 *  decide whether to use a fallback instead of blindly overwriting). */
function labelsToPriority(labels: Array<{ name: string }>): AahpTask['priority'] | undefined {
  const names = labels.map(l => l.name.toLowerCase())
  if (names.some(n => n.includes('high') || n.includes('bug') || n.includes('critical') || n.includes('urgent'))) return 'high'
  if (names.some(n => n.includes('medium') || n.includes('enhancement') || n.includes('feature'))) return 'medium'
  if (names.some(n => n.includes('low'))) return 'low'
  return undefined
}

/** Extract priority from a title containing [high], [medium], [low], or (high priority) etc. */
function extractPriorityFromTitle(title: string): AahpTask['priority'] | undefined {
  const lower = title.toLowerCase()
  const bracket = lower.match(/\[(high|medium|low)\]/)
  if (bracket?.[1]) return bracket[1] as AahpTask['priority']
  const paren = lower.match(/\(?(high|medium|low)\s*priority\)?/)
  if (paren?.[1]) return paren[1] as AahpTask['priority']
  return undefined
}

/** Map GitHub issue state + labels to an AAHP task status.
 *  closed (not_planned)   → cancelled
 *  closed (other)         → done
 *  open + wip/in-progress label → in_progress
 *  open + blocked/on-hold label → blocked
 *  open (default)         → ready */
function githubStateToAahpStatus(
  state: string,
  labels: Array<{ name: string }>,
  stateReason?: string | null
): AahpTask['status'] {
  if (state === 'closed') {
    return stateReason === 'not_planned' ? 'cancelled' : 'done'
  }
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

/** Jaccard word-overlap similarity between two task titles (after normalization).
 *  Returns 0..1; >= 0.55 is a good threshold for fuzzy matching. */
function titleSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(normalizeTitle(s).split(' ').filter(w => w.length >= 3))
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return 0
  const intersection = [...wa].filter(w => wb.has(w)).length
  const union = new Set([...wa, ...wb]).size
  return intersection / union
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

/** Detect and close duplicate open GitHub issues in a repo.
 *  Two issues are considered duplicates when:
 *   - they share the same T-NNN task ID in their title, OR
 *   - their normalized titles have >= 0.85 Jaccard similarity
 *  The lower-numbered (older) issue is kept; the higher-numbered (newer) one
 *  is closed with a "Duplicate of #N" comment and marked `not_planned`.
 *  MANIFEST tasks linked to closed duplicates are removed (the keeper task
 *  already covers the work). Returns updated manifest. */
export function deduplicateGitHubIssues(
  repoPath: string,
  handoffDir: string,
  manifest: AahpManifest,
  onLog?: (msg: string) => void
): AahpManifest {
  const repo = detectGitHubRepo(repoPath)
  if (!repo) return manifest

  let openIssues: GitHubIssue[]
  try {
    const out = execSync(
      `gh issue list --repo ${repo} --state open --json number,title,labels --limit 200`,
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
    ).toString()
    openIssues = JSON.parse(out) as GitHubIssue[]
  } catch {
    return manifest
  }

  if (openIssues.length < 2) return manifest

  const DEDUP_THRESHOLD = 0.85
  const closedNums = new Set<number>()

  // Group by T-NNN id first (exact), then by title similarity
  for (let i = 0; i < openIssues.length; i++) {
    const a = openIssues[i]!
    if (closedNums.has(a.number)) continue

    for (let j = i + 1; j < openIssues.length; j++) {
      const b = openIssues[j]!
      if (closedNums.has(b.number)) continue

      const aId = extractTaskIdFromIssueTitle(a.title)
      const bId = extractTaskIdFromIssueTitle(b.title)
      const sameTaskId = aId && bId && aId === bId
      const similarity = sameTaskId ? 1 : titleSimilarity(a.title, b.title)

      if (sameTaskId || similarity >= DEDUP_THRESHOLD) {
        // Keep lower number (older); close higher number (newer)
        const keep = a.number < b.number ? a : b
        const close = a.number < b.number ? b : a

        onLog?.(`[DEDUP] closing #${close.number} as duplicate of #${keep.number} (${sameTaskId ? 'same task ID' : `${Math.round(similarity * 100)}% similarity`}): "${close.title}"`)

        try {
          spawnSync('gh', [
            'issue', 'close', String(close.number),
            '--repo', repo,
            '--reason', 'not planned',
            '--comment', `Duplicate of #${keep.number} — closed automatically by AAHP duplicate detector.`,
          ], { cwd: repoPath, timeout: 15000, encoding: 'utf8' })
        } catch { /* best-effort */ }

        closedNums.add(close.number)
      }
    }
  }

  if (closedNums.size === 0) return manifest

  // Remove or cancel MANIFEST tasks linked to closed duplicate issues
  const tasks = manifest.tasks ?? {}
  let changed = false
  for (const [taskId, task] of Object.entries(tasks)) {
    if (typeof task.github_issue === 'number' && closedNums.has(task.github_issue)) {
      onLog?.(`[DEDUP] ${taskId} linked to closed duplicate #${task.github_issue} — removing from manifest`)
      delete tasks[taskId]
      changed = true
    }
  }

  if (!changed) return manifest
  const updated: AahpManifest = { ...manifest, tasks }
  fs.writeFileSync(path.join(handoffDir, 'MANIFEST.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')
  return updated
}

/** For every actionable task that has no GitHub issue, create one and link it back.
 *  Writes MANIFEST.json if any issues were created. Returns updated manifest. */
export function createMissingGitHubIssues(
  repoPath: string,
  handoffDir: string,
  manifest: AahpManifest,
  onLog?: (msg: string) => void
): AahpManifest {
  const repo = detectGitHubRepo(repoPath)
  if (!repo) return manifest

  const tasks = manifest.tasks ?? {}
  const toCreate = Object.entries(tasks).filter(
    ([, t]) => !t.github_issue &&
      (t.status === 'ready' || t.status === 'in_progress' || t.status === 'blocked')
  ) as Array<[string, AahpTask]>

  if (toCreate.length === 0) return manifest

  // Pre-flight: fetch open issues to avoid creating duplicates on retried/crashed runs
  let existingOpen: GitHubIssue[] = []
  try {
    const out = execSync(
      `gh issue list --repo ${repo} --state open --json number,title --limit 200`,
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
    ).toString()
    existingOpen = JSON.parse(out) as GitHubIssue[]
  } catch { /* gh unavailable - skip pre-flight, proceed with creation */ }

  const PREFLIGHT_THRESHOLD = 0.85

  onLog?.(`[SYNC] creating ${toCreate.length} missing GitHub issue(s) in ${repo}`)

  // Ensure all needed labels exist before creating issues
  const labelsNeeded = new Set(toCreate.flatMap(([, t]) => [t.priority, t.status]))
  for (const key of labelsNeeded) {
    const lbl = PRIORITY_LABELS[key] ?? STATUS_LABELS[key]
    if (lbl) ensureLabel(repo, lbl.name, lbl.color, repoPath)
  }

  let changed = false
  for (const [taskId, task] of toCreate) {
    // Reconcile priority: title may contain [high]/[medium]/[low] that overrides task.priority
    const titlePri = extractPriorityFromTitle(task.title)
    if (titlePri && titlePri !== task.priority) {
      task.priority = titlePri
    }

    const title = `[${taskId}] ${task.title}`

    // Pre-flight dedup: skip creation if an open issue with same task-ID or near-identical title already exists
    if (existingOpen.length > 0) {
      const clash = existingOpen.find(i => {
        const iTaskId = extractTaskIdFromIssueTitle(i.title)
        if (iTaskId && iTaskId === taskId) return true
        return titleSimilarity(i.title, title) >= PREFLIGHT_THRESHOLD
      })
      if (clash) {
        onLog?.(`[DEDUP] ${taskId} skipped — open issue #${clash.number} already covers this task: "${clash.title}"`)
        task.github_issue = clash.number
        task.github_repo = repo
        changed = true
        continue
      }
    }

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
          onLog?.(`[SYNC] created issue #${task.github_issue} for ${taskId}: "${task.title}"`)
        }
      } else if (result.status !== 0) {
        onLog?.(`[SYNC] WARN could not create issue for ${taskId} (gh exit ${result.status ?? 'null'})`)
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
  manifest: AahpManifest,
  onLog?: (msg: string) => void
): AahpManifest {
  const repo = detectGitHubRepo(repoPath)
  if (!repo) return manifest

  let issues: GitHubIssue[]
  try {
    const output = execSync(
      `gh issue list --repo ${repo} --state all --json number,title,body,labels,state,stateReason --limit 100`,
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
    ).toString()
    issues = (JSON.parse(output) as GitHubIssue[]).map(i => ({ ...i, state: i.state.toLowerCase() as 'open' | 'closed' }))
  } catch {
    // gh not installed, not authenticated, or no GitHub remote - skip silently
    return manifest
  }

  if (!issues.length) return manifest
  const openCount = issues.filter(i => i.state === 'open').length
  onLog?.(`[SYNC] ${repo}: ${issues.length} issues (${openCount} open)`)

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
    const githubStatus = githubStateToAahpStatus(issue.state, issue.labels, issue.stateReason)

    if (importedIssueNumbers.has(issue.number)) {
      // Already linked - sync task status with GitHub issue state
      const linkedId = issueNumToTaskId.get(issue.number)
      if (linkedId && tasks[linkedId]) {
        const task = tasks[linkedId]!
        const taskStatus = task.status as string
        if (issue.state === 'closed' && taskStatus !== 'done' && taskStatus !== 'cancelled') {
          // Issue closed - mark done or cancelled depending on stateReason
          onLog?.(`[SYNC] ${linkedId} ${taskStatus}→${githubStatus} (issue #${issue.number} closed)`)
          task.status = githubStatus  // 'done' or 'cancelled'
          if (!task.completed) task.completed = new Date().toISOString()
          changed = true
        } else if (issue.state === 'open' && (taskStatus === 'done' || taskStatus === 'completed' || taskStatus === 'cancelled')) {
          // Issue re-opened but task was marked done/cancelled - restore to ready
          onLog?.(`[SYNC] ${linkedId} ${taskStatus}→${githubStatus} (issue #${issue.number} reopened)`)
          task.status = githubStatus
          delete task.completed
          changed = true
        }
        // Sync priority from current GitHub labels (only when issue has a priority label)
        const ghPriority = labelsToPriority(issue.labels)
        if (ghPriority && task.priority !== ghPriority) {
          task.priority = ghPriority
          changed = true
        }
      }
      continue
    }

    // Don't create new MANIFEST tasks from already-closed GitHub issues.
    if (issue.state === 'closed') continue

    // 1. Match by T-NNN embedded in the issue title
    const existingTaskId = extractTaskIdFromIssueTitle(issue.title)
    if (existingTaskId && tasks[existingTaskId]) {
      const existingTask = tasks[existingTaskId]!
      let taskChanged = false

      if (existingTask.github_issue !== issue.number || existingTask.github_repo !== repo) {
        existingTask.github_issue = issue.number
        existingTask.github_repo = repo
        taskChanged = true
        onLog?.(`[SYNC] issue #${issue.number} → ${existingTaskId} (T-ID match)`)
      }

      const shouldSyncStatus = githubStatus === 'done' || existingTask.status !== 'in_progress'
      if (shouldSyncStatus && existingTask.status !== githubStatus) {
        existingTask.status = githubStatus
        taskChanged = true
      }
      // Sync priority from current GitHub labels
      const ghPriority1 = labelsToPriority(issue.labels)
      if (ghPriority1 && existingTask.priority !== ghPriority1) { existingTask.priority = ghPriority1; taskChanged = true }

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
      // Sync priority from current GitHub labels
      const ghPriority2 = labelsToPriority(issue.labels)
      if (ghPriority2) existingTask.priority = ghPriority2
      titleToTaskId.delete(normalizedIssueTitle)
      importedIssueNumbers.add(issue.number)
      onLog?.(`[SYNC] issue #${issue.number} → ${titleMatchId} (title match)`)
      changed = true
      continue
    }

    // 3. Fuzzy fallback: word-overlap similarity >= 0.55 (handles slightly different titles)
    const FUZZY_THRESHOLD = 0.55
    let fuzzyMatchId: string | undefined
    let fuzzyBestScore = 0
    for (const [ntitle, ftaskId] of titleToTaskId) {
      const score = titleSimilarity(normalizedIssueTitle, ntitle)
      if (score > fuzzyBestScore && score >= FUZZY_THRESHOLD) {
        fuzzyBestScore = score
        fuzzyMatchId = ftaskId
      }
    }
    if (fuzzyMatchId && tasks[fuzzyMatchId]) {
      const existingTask = tasks[fuzzyMatchId]!
      existingTask.github_issue = issue.number
      existingTask.github_repo = repo
      const shouldSyncStatus = githubStatus === 'done' || existingTask.status !== 'in_progress'
      if (shouldSyncStatus && existingTask.status !== githubStatus) existingTask.status = githubStatus
      // Sync priority from current GitHub labels
      const ghPriority3 = labelsToPriority(issue.labels)
      if (ghPriority3) existingTask.priority = ghPriority3
      titleToTaskId.delete(normalizeTitle(existingTask.title))
      importedIssueNumbers.add(issue.number)
      onLog?.(`[SYNC] issue #${issue.number} → ${fuzzyMatchId} (fuzzy ${Math.round(fuzzyBestScore * 100)}%: "${issue.title}")`)
      changed = true
      continue
    }

    const taskId = `T-${String(nextId).padStart(3, '0')}`
    tasks[taskId] = {
      title: issue.title,
      status: githubStatus,
      priority: labelsToPriority(issue.labels) ?? extractPriorityFromTitle(issue.title) ?? 'medium',
      depends_on: [],
      created: new Date().toISOString(),
      notes: issue.body ? issue.body.slice(0, 500) : undefined,
      github_issue: issue.number,
      github_repo: repo,
    }
    nextId++
    onLog?.(`[SYNC] issue #${issue.number} imported as ${taskId}: "${issue.title}"`)
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
            const pri = extractPriorityFromTitle(title)
            if (section !== 'done') items.push({ section, taskId: taskH[1]?.toUpperCase(), title, ...(pri ? { priority: pri } : {}) })
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
        const rawTitle = check[2].replace(/\*+/g, '').trim()
        const title = rawTitle.replace(/\(?(high|medium|low)\s*priority\)?/i, '').replace(/\s*\[(high|medium|low)\]\s*/i, ' ').trim()
        const pri = rawTitle.match(/\(?(high|medium|low)\s*priority\)?/i)?.[1]?.toLowerCase() ?? extractPriorityFromTitle(rawTitle)
        if (title.length >= 8) items.push({ section, title, ...(pri ? { priority: pri } : {}) })
      }
    }
  }
  return items
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
  const existingTitles = new Set(Object.values(tasks).map(t => normalizeTitle(t.title)))

  for (const item of actionable) {
    if (item.taskId && tasks[item.taskId]) continue
    if (existingTitles.has(normalizeTitle(item.title))) continue
    // Fuzzy dedup: skip if a very similar task already exists (>= 65% word overlap)
    if (Object.values(tasks).some(t => titleSimilarity(item.title, t.title) >= 0.65)) continue

    while (tasks[`T-${String(nextId).padStart(3, '0')}`]) nextId++
    const taskId = item.taskId ?? `T-${String(nextId).padStart(3, '0')}`

    const status: AahpTask['status'] =
      item.section === 'in_progress' ? 'in_progress' :
      item.section === 'blocked' ? 'blocked' : 'ready'
    const titlePri = extractPriorityFromTitle(item.title)
    const priority: AahpTask['priority'] =
      item.priority === 'high' ? 'high' :
      item.priority === 'medium' ? 'medium' :
      item.priority === 'low' ? 'low' :
      titlePri ?? 'medium'

    tasks[taskId] = {
      title: item.title.replace(/\s*\(issue #\d+\)\s*/gi, '').trim(),
      status, priority, depends_on: [], created: new Date().toISOString(),
    }
    existingTitles.add(normalizeTitle(item.title))
    nextId++
    changed = true
  }

  if (!changed) return manifest
  const updated: AahpManifest = { ...manifest, tasks, next_task_id: nextId }
  fs.writeFileSync(path.join(handoffDir, 'MANIFEST.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')
  return updated
}

/** Extract TODO/roadmap items from README.md and register them as MANIFEST tasks.
 *  Only reads sections whose heading matches: Roadmap, TODO, Next Steps, Planned,
 *  Backlog, Upcoming, Future, Work in Progress. Picks up unchecked checkboxes only. */
export function extractReadmeNextSteps(
  repoPath: string,
  handoffDir: string,
  manifest: AahpManifest,
  onLog?: (msg: string) => void
): AahpManifest {
  let content: string
  try { content = fs.readFileSync(path.join(repoPath, 'README.md'), 'utf8') } catch { return manifest }

  const items: string[] = []
  let inTargetSection = false

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/)
    if (headingMatch) {
      const h = headingMatch[2]!.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim()
      inTargetSection = /roadmap|todo|next steps?|planned|backlog|upcoming|future|work in progress/i.test(h)
      continue
    }
    if (!inTargetSection) continue
    const cbMatch = trimmed.match(/^-\s+\[\s*\]\s+(.+)/)
    if (cbMatch?.[1]) {
      const title = cbMatch[1].replace(/\*+/g, '').replace(/\s*\(issue #\d+\)\s*/gi, '').trim()
      if (title.length >= 10) items.push(title)
    }
  }

  if (items.length === 0) return manifest

  const tasks = manifest.tasks ?? {}
  let nextId = manifest.next_task_id ?? (Object.keys(tasks).length + 1)
  let changed = false
  const existingTitles = new Set(Object.values(tasks).map(t => normalizeTitle(t.title)))

  for (const title of items) {
    if (existingTitles.has(normalizeTitle(title))) continue
    if (Object.values(tasks).some(t => titleSimilarity(title, t.title) >= 0.65)) continue

    while (tasks[`T-${String(nextId).padStart(3, '0')}`]) nextId++
    const taskId = `T-${String(nextId).padStart(3, '0')}`
    tasks[taskId] = {
      title,
      status: 'ready',
      priority: extractPriorityFromTitle(title) ?? 'medium',
      depends_on: [],
      created: new Date().toISOString(),
      notes: 'Imported from README.md',
    }
    existingTitles.add(normalizeTitle(title))
    nextId++
    changed = true
    onLog?.(`[SYNC] README → ${taskId}: "${title}"`)
  }

  if (!changed) return manifest
  const updated: AahpManifest = { ...manifest, tasks, next_task_id: nextId }
  fs.writeFileSync(path.join(handoffDir, 'MANIFEST.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')
  return updated
}

/** After creating/linking GitHub issues, write (issue #N) annotations back into
 *  NEXT_ACTIONS.md headings so LLMs reading the file can see the linked issue.
 *  Only modifies lines that are task headings (## or ###). */
export function annotateNextActionsWithIssues(
  handoffDir: string,
  tasks: Record<string, AahpTask>,
  onLog?: (msg: string) => void
): void {
  const naPath = path.join(handoffDir, 'NEXT_ACTIONS.md')
  let content: string
  try { content = fs.readFileSync(naPath, 'utf8') } catch { return }

  // Build lookups: taskId → issueNumber, normalizedTitle → issueNumber
  const taskIdToIssue = new Map<string, number>()
  const normTitleToIssue = new Map<string, number>()
  for (const [id, task] of Object.entries(tasks)) {
    if (typeof task.github_issue === 'number' && task.github_issue > 0) {
      taskIdToIssue.set(id.toUpperCase(), task.github_issue)
      normTitleToIssue.set(normalizeTitle(task.title), task.github_issue)
    }
  }
  if (taskIdToIssue.size === 0 && normTitleToIssue.size === 0) return

  let changed = false
  let annotated = 0
  const lines = content.split('\n')
  const updated = lines.map(line => {
    const m = line.match(/^(#{2,4})\s+(?:~~)?(?:(T-\d+)[:\s]+)?(.+?)(?:~~)?\s*$/)
    if (!m) return line
    const hashes = m[1]!
    const taskId = m[2]?.toUpperCase()
    // Strip any existing annotation to avoid duplication
    const cleanTitle = m[3]!.replace(/\s*\(issue #\d+\)\s*/gi, '').trim()

    let issueNum = taskId ? taskIdToIssue.get(taskId) : undefined
    if (!issueNum) issueNum = normTitleToIssue.get(normalizeTitle(cleanTitle))
    if (!issueNum) return line

    const rebuilt = taskId
      ? `${hashes} ${taskId}: ${cleanTitle} (issue #${issueNum})`
      : `${hashes} ${cleanTitle} (issue #${issueNum})`

    if (rebuilt !== line.trimEnd()) {
      changed = true
      annotated++
      return rebuilt
    }
    return line
  })

  if (changed) {
    fs.writeFileSync(naPath, updated.join('\n'), 'utf8')
    onLog?.(`[SYNC] NEXT_ACTIONS.md annotated: ${annotated} heading(s) updated with issue link(s)`)
  }
}

/** Resolve the handoff directory for a repo (.ai/handoff/ per AAHP protocol). */
function resolveHandoffDir(repoPath: string): string | undefined {
  const aiHandoff = path.join(repoPath, '.ai', 'handoff')
  if (fs.existsSync(path.join(aiHandoff, 'MANIFEST.json'))) return aiHandoff
  return undefined
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
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const repoPath = path.join(rootDir, entry.name)
    const handoffDir = resolveHandoffDir(repoPath)
    if (!handoffDir) continue
    const manifestPath = path.join(handoffDir, 'MANIFEST.json')

    if (!fs.existsSync(manifestPath)) continue

    let manifest: AahpManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AahpManifest
    } catch {
      continue
    }

    const _logDate = new Date().toISOString().slice(0, 10)
    const _logDir = path.join(repoPath, '.ai', 'logs')
    const _logFile = path.join(_logDir, `${_logDate}.log`)
    const repoLog = (msg: string) => {
      try {
        fs.mkdirSync(_logDir, { recursive: true })
        fs.appendFileSync(_logFile, `${new Date().toISOString().slice(11, 19)} ${msg}\n`)
      } catch { /* best-effort */ }
    }
    // Bootstrap: always create .ai/logs/ and gitignore entry on first scan,
    // even if no sync events fire (no GitHub activity → repoLog never called otherwise)
    try {
      fs.mkdirSync(_logDir, { recursive: true })
      const giPath = path.join(repoPath, '.gitignore')
      const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : ''
      if (!gi.split('\n').some(l => l.trim() === '.ai/logs/')) {
        fs.appendFileSync(giPath, (gi.endsWith('\n') || gi === '' ? '' : '\n') + '.ai/logs/\n')
      }
      fs.appendFileSync(_logFile, `${new Date().toISOString().slice(11, 19)} SCAN  ${manifest.project ?? entry.name}\n`)
    } catch { /* best-effort */ }

    // Sync GitHub issues → MANIFEST, ensure NEXT_ACTIONS items have MANIFEST entries, then push unlinked tasks → GitHub
    manifest = fetchAndImportGitHubIssues(repoPath, handoffDir, manifest, repoLog)
    manifest = syncNextActionsToManifest(repoPath, handoffDir, manifest)
    manifest = extractReadmeNextSteps(repoPath, handoffDir, manifest, repoLog)
    manifest = deduplicateGitHubIssues(repoPath, handoffDir, manifest, repoLog)
    manifest = createMissingGitHubIssues(repoPath, handoffDir, manifest, repoLog)
    // Write issue numbers back into NEXT_ACTIONS.md so LLMs reading it see the GitHub links
    annotateNextActionsWithIssues(handoffDir, manifest.tasks ?? {}, repoLog)

    const tasks = manifest.tasks ?? {}
    const readyTasks = Object.entries(tasks).filter(
      ([, t]) => t.status === 'ready'
    ) as Array<[string, AahpTask]>
    const activeTasks = Object.entries(tasks).filter(
      ([, t]) => t.status === 'in_progress'
    ) as Array<[string, AahpTask]>
    const blockedTasks = Object.entries(tasks).filter(
      ([, t]) => t.status === 'blocked'
    ) as Array<[string, AahpTask]>
    const cancelledTasks = Object.entries(tasks).filter(
      ([, t]) => t.status === 'cancelled'
    ) as Array<[string, AahpTask]>

    projects.push({
      name: manifest.project || entry.name,
      repoPath,
      handoffDir,
      manifest,
      readyTasks,
      activeTasks,
      blockedTasks,
      cancelledTasks,
      isLocalOnly: !detectGitHubRepo(repoPath),
    })
  }

  return projects.sort((a, b) => {
    // Sort: active first, then by number of ready+blocked tasks
    const aScore = a.activeTasks.length * 10 + a.readyTasks.length + a.blockedTasks.length
    const bScore = b.activeTasks.length * 10 + b.readyTasks.length + b.blockedTasks.length
    return bScore - aScore
  })
}

/** Bootstrap a brand-new repo: create .ai/handoff/MANIFEST.json with no tasks,
 *  then immediately scan it (which fetches GitHub issues) so it joins the pool. */
export function bootstrapProject(repoPath: string): AahpProject | undefined {
  const projectName = path.basename(repoPath)
  // If a handoff dir already exists (standard OR legacy root location), just scan it
  const existing = resolveHandoffDir(repoPath)
  if (existing) return scanProjectByPath(repoPath)

  // Create the standard .ai/handoff/ structure
  const handoffDir = path.join(repoPath, '.ai', 'handoff')
  const manifestPath = path.join(handoffDir, 'MANIFEST.json')
  try {
    fs.mkdirSync(handoffDir, { recursive: true })
    const seed = {
      aahp_version: '3.0',
      project: projectName,
      tasks: {},
      next_task_id: 1,
    }
    fs.writeFileSync(manifestPath, JSON.stringify(seed, null, 2) + '\n', 'utf8')
  } catch {
    return undefined
  }
  return scanProjectByPath(repoPath)
}

export function scanProjectByPath(repoPath: string): AahpProject | undefined {
  const handoffDir = resolveHandoffDir(repoPath)
  if (!handoffDir) return undefined
  const manifestPath = path.join(handoffDir, 'MANIFEST.json')
  if (!fs.existsSync(manifestPath)) return undefined

  let manifest: AahpManifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AahpManifest
  } catch {
    return undefined
  }

  const _logDate = new Date().toISOString().slice(0, 10)
  const _logDir = path.join(repoPath, '.ai', 'logs')
  const _logFile = path.join(_logDir, `${_logDate}.log`)
  const repoLog = (msg: string) => {
    try {
      fs.mkdirSync(_logDir, { recursive: true })
      fs.appendFileSync(_logFile, `${new Date().toISOString().slice(11, 19)} ${msg}\n`)
    } catch { /* best-effort */ }
  }
  // Bootstrap: always create .ai/logs/ and gitignore entry on first scan
  try {
    fs.mkdirSync(_logDir, { recursive: true })
    const giPath = path.join(repoPath, '.gitignore')
    const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : ''
    if (!gi.split('\n').some(l => l.trim() === '.ai/logs/')) {
      fs.appendFileSync(giPath, (gi.endsWith('\n') || gi === '' ? '' : '\n') + '.ai/logs/\n')
    }
    fs.appendFileSync(_logFile, `${new Date().toISOString().slice(11, 19)} SCAN  ${manifest.project ?? path.basename(repoPath)}\n`)
  } catch { /* best-effort */ }

  manifest = fetchAndImportGitHubIssues(repoPath, handoffDir, manifest, repoLog)
  manifest = syncNextActionsToManifest(repoPath, handoffDir, manifest)
  manifest = extractReadmeNextSteps(repoPath, handoffDir, manifest, repoLog)
  manifest = deduplicateGitHubIssues(repoPath, handoffDir, manifest, repoLog)
  manifest = createMissingGitHubIssues(repoPath, handoffDir, manifest, repoLog)
  annotateNextActionsWithIssues(handoffDir, manifest.tasks ?? {}, repoLog)

  const tasks = manifest.tasks ?? {}
  const readyTasks = Object.entries(tasks).filter(
    ([, t]) => t.status === 'ready'
  ) as Array<[string, AahpTask]>
  const activeTasks = Object.entries(tasks).filter(
    ([, t]) => t.status === 'in_progress'
  ) as Array<[string, AahpTask]>
  const blockedTasks = Object.entries(tasks).filter(
    ([, t]) => t.status === 'blocked'
  ) as Array<[string, AahpTask]>
  const cancelledTasks = Object.entries(tasks).filter(
    ([, t]) => t.status === 'cancelled'
  ) as Array<[string, AahpTask]>

  return {
    name: manifest.project || path.basename(repoPath),
    repoPath,
    handoffDir,
    manifest,
    readyTasks,
    activeTasks,
    blockedTasks,
    cancelledTasks,
    isLocalOnly: !detectGitHubRepo(repoPath),
  }
}

export function getTopTask(project: AahpProject): [string, AahpTask] | undefined {
  if (project.activeTasks.length > 0) return project.activeTasks[0]
  if (project.readyTasks.length > 0) return project.readyTasks[0]
  if (project.blockedTasks.length > 0) return project.blockedTasks[0]
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
      ? `   Then close GitHub issue #${task.github_issue}: run \`gh issue close ${task.github_issue} --repo ${task.github_repo} --comment "Resolved in [\`<short-sha>\`](https://github.com/${task.github_repo}/commit/<full-sha>) via AAHP task ${taskId}. <one-line summary>"\``
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

/** Build a planning-mode prompt for generating new NEXT_ACTIONS.md tasks.
 *  The planning agent reads the repo, writes NEXT_ACTIONS.md, and must NOT commit. */
export function buildPlanningPrompt(project: AahpProject): string {
  const m = project.manifest

  const tryRead = (filePath: string, maxLen = 3000): string => {
    try { return fs.readFileSync(filePath, 'utf8').slice(0, maxLen) } catch { return '' }
  }

  const readme   = tryRead(path.join(project.repoPath, 'README.md'))
  const pkg      = tryRead(path.join(project.repoPath, 'package.json'), 1000)
  const existing = tryRead(path.join(project.handoffDir, 'NEXT_ACTIONS.md'), 2000)

  const doneTasks = Object.entries(m.tasks ?? {})
    .filter(([, t]) => t.status === 'done')
    .slice(-5)
    .map(([id, t]) => `  ${id}: ${t.title}`)
    .join('\n')

  const nextId = `T-${String(m.next_task_id ?? 1).padStart(3, '0')}`

  return [
    `## AAHP Planning Mode — ${m.project}`,
    `Phase: ${m.last_session.phase}`,
    m.quick_context ? `\n### Project Context\n${m.quick_context}\n` : '',
    readme          ? `### README (excerpt)\n${readme}\n` : '',
    pkg             ? `### package.json\n${pkg}\n` : '',
    doneTasks       ? `### Recently Completed Tasks\n${doneTasks}\n` : '',
    existing        ? `### Existing NEXT_ACTIONS.md\n${existing}\n` : '',
    `---`,
    `You are a software project planner. Analyze this repository and produce a fresh task roadmap.`,
    ``,
    `## Instructions`,
    `1. Read key files (source code, tests, config) to understand the project's current state`,
    `2. Review recently completed tasks above to understand momentum and avoid duplicates`,
    `3. Identify 3-5 concrete, actionable next steps for this project`,
    `4. Write them to .ai/handoff/NEXT_ACTIONS.md using the AAHP v3 format shown below`,
    `5. Do NOT write any code`,
    `6. Do NOT run git commit or git push`,
    `7. Only modify the file .ai/handoff/NEXT_ACTIONS.md`,
    ``,
    `## NEXT_ACTIONS.md Format`,
    `\`\`\``,
    `# NEXT_ACTIONS — {project}`,
    ``,
    `## ⚡ Ready - Work These Next`,
    ``,
    `### ${nextId}: Task Title Here`,
    `- **Goal:** What this task achieves`,
    `- **Context:** Why it matters now / current state`,
    `- **What to do:** Step-by-step concrete actions`,
    `- **Files:** Key files to read or modify`,
    `- **Definition of Done:**`,
    `  - [ ] Specific acceptance criterion`,
    ``,
    `## 🚫 Blocked`,
    `(none)`,
    ``,
    `## ✅ Recently Completed`,
    doneTasks || '(see MANIFEST.json)',
    `\`\`\``,
    ``,
    `Task IDs start from ${nextId}. Use priority: high / medium / low in the task title suffix like: ### ${nextId}: Title [high]`,
    ``,
    `Work directory: ${project.repoPath}`,
    `IMPORTANT: Write ONLY to .ai/handoff/NEXT_ACTIONS.md. Do not commit. Do not push.`,
  ].filter(s => s !== undefined).join('\n')
}

export interface GitRepoInfo {
  name: string
  repoPath: string
  hasManifest: boolean
  isGitHub: boolean
  githubRepo: string | null
}

/** Find ALL git repos in rootDir, whether or not they have AAHP MANIFEST.json */
export function scanAllGitRepos(rootDir: string): GitRepoInfo[] {
  const results: GitRepoInfo[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch { return results }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const repoPath = path.join(rootDir, entry.name)
    if (!fs.existsSync(path.join(repoPath, '.git'))) continue
    const hasManifest = !!resolveHandoffDir(repoPath)
    const githubRepo = detectGitHubRepo(repoPath)
    results.push({ name: entry.name, repoPath, hasManifest, isGitHub: !!githubRepo, githubRepo })
  }
  return results
}
