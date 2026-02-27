import * as vscode from 'vscode'
import { readLiveSessions, getLastLogLine, scanWorkspaceProjects, type WorkspaceProject } from './data-reader'

export class AgentTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return []

    const items: vscode.TreeItem[] = []

    // Live running agents
    const sessions = readLiveSessions()
    if (sessions.length > 0) {
      const header = new vscode.TreeItem('Running Agents', vscode.TreeItemCollapsibleState.None)
      header.description = `${sessions.length} active`
      header.iconPath = new vscode.ThemeIcon('sync~spin')
      items.push(header)

      for (const s of sessions) {
        const elapsed = s.startedAt
          ? Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000)
          : 0
        const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`

        const item = new vscode.TreeItem(s.repoName ?? 'unknown', vscode.TreeItemCollapsibleState.None)
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
        // Add separator
        const sep = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None)
        items.push(sep)
      }

      const header = new vscode.TreeItem('Projects', vscode.TreeItemCollapsibleState.None)
      header.description = `${projects.length} found`
      header.iconPath = new vscode.ThemeIcon('repo')
      items.push(header)

      for (const p of projects) {
        const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.None)

        // Count tasks by status
        const tasks = p.manifest.tasks ?? {}
        const taskEntries = Object.entries(tasks)
        const ready = taskEntries.filter(([, t]) => t.status === 'ready').length
        const inProgress = taskEntries.filter(([, t]) => t.status === 'in_progress').length
        const done = taskEntries.filter(([, t]) => t.status === 'done').length

        const phase = p.manifest.last_session?.phase ?? 'unknown'
        item.description = `[${phase}] ${ready} ready, ${inProgress} active, ${done} done`

        // Icon based on phase
        const phaseIcon = phase === 'idle' ? 'circle-outline'
          : phase === 'working' ? 'sync~spin'
          : phase === 'reviewing' ? 'eye'
          : 'circle-outline'
        item.iconPath = new vscode.ThemeIcon(phaseIcon)

        // Top ready task in tooltip
        const readyTasks = taskEntries.filter(([, t]) => t.status === 'ready')
        const topTask = readyTasks[0]
        const tooltipLines = [
          `**${p.name}** - ${p.manifest.quick_context ?? ''}`,
          '',
          `Phase: ${phase}`,
          `Version: ${p.manifest.aahp_version ?? '?'}`,
          `Last agent: ${p.manifest.last_session?.agent ?? 'none'}`,
          `Last updated: ${p.manifest.last_session?.timestamp ?? 'never'}`,
        ]
        if (topTask) {
          tooltipLines.push('', `Next task: [${topTask[0]}] ${topTask[1].title} (${topTask[1].priority})`)
        }
        item.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'))

        // Click to open MANIFEST.json
        item.command = {
          command: 'vscode.open',
          title: 'Open MANIFEST.json',
          arguments: [vscode.Uri.file(p.manifestPath)],
        }

        items.push(item)
      }
    }

    // Empty state
    if (items.length === 0) {
      const noProjects = new vscode.TreeItem('No AAHP projects found', vscode.TreeItemCollapsibleState.None)
      noProjects.description = 'Open a folder with .ai/handoff/MANIFEST.json'
      noProjects.iconPath = new vscode.ThemeIcon('info')
      items.push(noProjects)

      const setup = new vscode.TreeItem('Set up AAHP v3', vscode.TreeItemCollapsibleState.None)
      setup.iconPath = new vscode.ThemeIcon('link-external')
      setup.command = {
        command: 'vscode.open',
        title: 'Open AAHP docs',
        arguments: [vscode.Uri.parse('https://github.com/elvatis/AAHP')],
      }
      items.push(setup)
    }

    return items
  }
}
