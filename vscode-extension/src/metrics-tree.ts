import * as vscode from 'vscode'
import { readMetrics, computeSummary } from './data-reader'

export class MetricsTreeProvider implements vscode.TreeDataProvider<MetricItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MetricItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: MetricItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: MetricItem): MetricItem[] {
    if (element) return element.children ?? []

    const metrics = readMetrics(100)

    if (metrics.length === 0) {
      const noData = new MetricItem('No metrics yet', vscode.TreeItemCollapsibleState.None)
      noData.description = 'Metrics are recorded after each agent run'
      noData.iconPath = new vscode.ThemeIcon('info')
      return [noData]
    }

    const summary = computeSummary(metrics)
    const items: MetricItem[] = []

    // Summary section
    const summaryItem = new MetricItem('Summary', vscode.TreeItemCollapsibleState.Expanded)
    summaryItem.iconPath = new vscode.ThemeIcon('graph')
    summaryItem.children = [
      MetricItem.stat('Total runs', String(summary.totalRuns)),
      MetricItem.stat('Success rate', `${summary.successRate}%`),
      MetricItem.stat('Avg duration', formatDuration(summary.avgDurationMs)),
    ]
    items.push(summaryItem)

    // Per-repo section
    const repoEntries = Object.entries(summary.byRepo).sort(([, a], [, b]) => b.runs - a.runs)
    if (repoEntries.length > 0) {
      const repoItem = new MetricItem('By Repository', vscode.TreeItemCollapsibleState.Collapsed)
      repoItem.iconPath = new vscode.ThemeIcon('repo')
      repoItem.children = repoEntries.map(([repo, stats]) => {
        const rate = stats.runs > 0 ? Math.round((stats.successes / stats.runs) * 100) : 0
        return MetricItem.stat(repo, `${stats.runs} runs, ${rate}% OK, avg ${formatDuration(stats.avgMs)}`)
      })
      items.push(repoItem)
    }

    // Recent runs section
    const recent = metrics.slice(-10).reverse()
    const recentItem = new MetricItem('Recent Runs', vscode.TreeItemCollapsibleState.Collapsed)
    recentItem.iconPath = new vscode.ThemeIcon('history')
    recentItem.children = recent.map(m => {
      const item = MetricItem.stat(
        `${m.repo} [${m.taskId}]`,
        `${m.success ? 'OK' : 'FAIL'} - ${formatDuration(m.durationMs)} - ${m.backend}`
      )
      item.iconPath = new vscode.ThemeIcon(m.success ? 'check' : 'error')
      return item
    })
    items.push(recentItem)

    return items
  }
}

class MetricItem extends vscode.TreeItem {
  children?: MetricItem[]

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState)
    this.contextValue = 'metric'
  }

  static stat(label: string, value: string): MetricItem {
    const item = new MetricItem(label, vscode.TreeItemCollapsibleState.None)
    item.description = value
    return item
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return remSec > 0 ? `${min}m${remSec}s` : `${min}m`
}
