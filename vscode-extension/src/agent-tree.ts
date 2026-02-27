import * as vscode from 'vscode'
import { readLiveSessions, getLastLogLine, type LiveSession } from './data-reader'

export class AgentTreeProvider implements vscode.TreeDataProvider<AgentItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: AgentItem): vscode.TreeItem {
    return element
  }

  getChildren(): AgentItem[] {
    const sessions = readLiveSessions()

    if (sessions.length === 0) {
      const noAgents = new AgentItem(
        'No agents running',
        '',
        vscode.TreeItemCollapsibleState.None
      )
      noAgents.description = 'Run: aahp run --all --yes'
      noAgents.iconPath = new vscode.ThemeIcon('info')
      return [noAgents]
    }

    return sessions.map(s => {
      const elapsed = s.startedAt
        ? Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000)
        : 0
      const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`

      const item = new AgentItem(
        s.repoName ?? 'unknown',
        `[${s.taskId}] ${s.taskTitle}`,
        vscode.TreeItemCollapsibleState.None
      )
      item.description = `${elapsedStr} (${s.backend})`
      item.iconPath = new vscode.ThemeIcon('sync~spin')
      item.tooltip = new vscode.MarkdownString(
        `**${s.repoName}** - [${s.taskId}] ${s.taskTitle}\n\n` +
        `Backend: ${s.backend}\n` +
        `Elapsed: ${elapsedStr}\n\n` +
        `Last log: ${getLastLogLine(s.repoName)}`
      )
      return item
    })
  }
}

class AgentItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public taskInfo: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState)
    this.contextValue = 'agent'
  }
}
