import * as fs from 'fs'
import * as path from 'path'
import type { AahpManifest, AahpProject, AahpTask } from './types.js'

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
    ``,
    `Work directory: ${project.repoPath}`,
    `Do NOT ask questions. Act autonomously based on the context above.`,
  ].filter(Boolean).join('\n')
}

export function saveManifest(project: AahpProject, manifest: AahpManifest): void {
  const p = path.join(project.handoffDir, 'MANIFEST.json')
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}
