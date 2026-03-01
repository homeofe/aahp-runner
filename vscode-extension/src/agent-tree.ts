import * as vscode from 'vscode'
import { readLiveSessions, getLastLogLine, scanWorkspaceProjects, type WorkspaceProject } from './data-reader'

// Custom tree item with extra data for children and commands
class AgentItem extends vscode.TreeItem {
  type: 'header' | 'session' | 'project' | 'task' | 'separator'
  projectData?: WorkspaceProject
  taskId?: string
  taskData?: { title: string; status: string; priority: string }
  children?: AgentItem[]

  constructor(
    label: string,
    type: AgentItem['type'],
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsible)
    this.type = type
  }
}

export class AgentTreeProvider implements vscode.TreeDataProvider<AgentItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: AgentItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: AgentItem): AgentItem[] {
    // Return task children for project items
    if (element) {
      return element.children ?? []
    }

    return this._getRootItems()
  }

  private _getRootItems(): AgentItem[] {
    const items: AgentItem[] = []

    // Live running agents
    const sessions = readLiveSessions()
    if (sessions.length > 0) {
      const header = new AgentItem('Running Agents', 'header')
      header.description = `${sessions.length} active`
      header.iconPath = new vscode.ThemeIcon('sync~spin')
      items.push(header)

      for (const s of sessions) {
        const elapsed = s.startedAt
          ? Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000)
          : 0
        const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`

        const item = new AgentItem(s.repoName ?? 'unknown', 'session')
        item.description = `[${s.taskId}] ${elapsedStr} (${s.backend})`
        item.iconPath = new vscode.ThemeIcon('sync~spin')
        item.tooltip = new vscode.MarkdownString(
          `**${s.repoName}** - [${s.taskId}] ${s.taskTitle}\n\n` +
          `Backend: ${s.backend}\n` +
          `Elapsed: ${elapsedStr}\n\n` +
          `Last log: ${getLastLogLine(s.repoName)}`
        )
        items.push(item)
      }
    }

    // Workspace projects from MANIFEST.json
    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []
    const projects = scanWorkspaceProjects(folders)

    if (projects.length > 0) {
      if (sessions.length > 0) {
        const sep = new AgentItem('', 'separator')
        items.push(sep)
      }

      const header = new AgentItem('Projects', 'header')
      header.description = `${projects.length} found`
      header.iconPath = new vscode.ThemeIcon('repo')
      items.push(header)

      for (const p of projects) {
        const tasks = p.manifest.tasks ?? {}
        const taskEntries = Object.entries(tasks)
        const ready = taskEntries.filter(([, t]) => t.status === 'ready').length
        const inProgress = taskEntries.filter(([, t]) => t.status === 'in_progress').length
        const done = taskEntries.filter(([, t]) => t.status === 'done').length

        const phase = p.manifest.last_session?.phase ?? 'unknown'
        const hasChildren = taskEntries.length > 0

        const item = new AgentItem(
          p.name,
          'project',
          hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        )
        item.description = `[${phase}] ${ready} ready, ${inProgress} active, ${done} done`
        item.projectData = p
        item.contextValue = 'aahpProject'

        // Icon based on phase
        const phaseIcon = phase === 'idle' ? 'circle-outline'
          : phase === 'working' ? 'sync~spin'
          : phase === 'reviewing' ? 'eye'
          : 'circle-outline'
        item.iconPath = new vscode.ThemeIcon(phaseIcon)

        // Tooltip with project details
        const readyTasks = taskEntries.filter(([, t]) => t.status === 'ready')
        const tooltipLines = [
          `**${p.name}** - ${p.manifest.quick_context ?? ''}`,
          '',
          `Phase: ${phase}`,
          `Version: ${p.manifest.aahp_version ?? '?'}`,
          `Last agent: ${p.manifest.last_session?.agent ?? 'none'}`,
          `Last updated: ${p.manifest.last_session?.timestamp ?? 'never'}`,
          '',
          `Tasks: ${ready} ready, ${inProgress} active, ${done} done (${taskEntries.length} total)`,
        ]
        if (readyTasks.length > 0) {
          tooltipLines.push('', '**Ready tasks:**')
          for (const [id, task] of readyTasks.slice(0, 5)) {
            tooltipLines.push(`- [${id}] ${task.title} (${task.priority})`)
          }
          if (readyTasks.length > 5) {
            tooltipLines.push(`  ...and ${readyTasks.length - 5} more`)
          }
        }
        item.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'))

        // Click opens MANIFEST.json
        item.command = {
          command: 'vscode.open',
          title: 'Open MANIFEST.json',
          arguments: [vscode.Uri.file(p.manifestPath)],
        }

        // Build task children
        item.children = taskEntries
          .sort((a, b) => {
            const order: Record<string, number> = { ready: 0, in_progress: 1, done: 2 }
            return (order[a[1].status] ?? 3) - (order[b[1].status] ?? 3)
          })
          .map(([id, task]) => {
            const taskItem = new AgentItem(`[${id}] ${task.title}`, 'task')
            taskItem.description = `${task.status} - ${task.priority}`
            taskItem.taskId = id
            taskItem.taskData = task
            taskItem.projectData = p

            // Icon based on task status
            if (task.status === 'ready') {
              taskItem.iconPath = new vscode.ThemeIcon('circle-outline')
              taskItem.contextValue = 'readyTask'
              // Click to fix with Claude
              taskItem.command = {
                command: 'aahp.fixTask',
                title: 'Fix with Claude',
                arguments: [p.repoPath, id, task.title],
              }
              taskItem.tooltip = new vscode.MarkdownString(
                `**[${id}] ${task.title}**\n\n` +
                `Status: ${task.status}\n` +
                `Priority: ${task.priority}\n\n` +
                `*Click to open Claude CLI and fix this task*`
              )
            } else if (task.status === 'in_progress') {
              taskItem.iconPath = new vscode.ThemeIcon('sync~spin')
              taskItem.contextValue = 'activeTask'
              taskItem.tooltip = new vscode.MarkdownString(
                `**[${id}] ${task.title}**\n\nStatus: in progress\nPriority: ${task.priority}`
              )
            } else {
              taskItem.iconPath = new vscode.ThemeIcon('check')
              taskItem.contextValue = 'doneTask'
              taskItem.tooltip = new vscode.MarkdownString(
                `**[${id}] ${task.title}**\n\nStatus: done\nPriority: ${task.priority}`
              )
            }

            return taskItem
          })

        items.push(item)
      }
    }

    // Empty state
    if (items.length === 0) {
      const noProjects = new AgentItem('No AAHP projects found', 'header')
      noProjects.description = 'Open a folder with .ai/handoff/MANIFEST.json'
      noProjects.iconPath = new vscode.ThemeIcon('info')
      items.push(noProjects)

      const setup = new AgentItem('Set up AAHP v3', 'header')
      setup.iconPath = new vscode.ThemeIcon('link-external')
      setup.command = {
        command: 'vscode.open',
        title: 'Open AAHP docs',
        arguments: [vscode.Uri.parse('https://github.com/homeofe/AAHP')],
      }
      items.push(setup)
    }

    return items
  }
}
