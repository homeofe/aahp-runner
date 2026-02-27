import * as vscode from 'vscode'
import { AgentTreeProvider } from './agent-tree'
import { MetricsTreeProvider } from './metrics-tree'
import { DashboardPanel } from './dashboard-panel'

export function activate(context: vscode.ExtensionContext) {
  // Tree view providers for the sidebar
  const agentProvider = new AgentTreeProvider()
  const metricsProvider = new MetricsTreeProvider()

  vscode.window.registerTreeDataProvider('aahp.agents', agentProvider)
  vscode.window.registerTreeDataProvider('aahp.metrics', metricsProvider)

  // Auto-refresh agents every 3 seconds
  const agentRefreshInterval = setInterval(() => agentProvider.refresh(), 3000)
  context.subscriptions.push({ dispose: () => clearInterval(agentRefreshInterval) })

  // Auto-refresh metrics every 30 seconds
  const metricsRefreshInterval = setInterval(() => metricsProvider.refresh(), 30000)
  context.subscriptions.push({ dispose: () => clearInterval(metricsRefreshInterval) })

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('aahp.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri)
    }),
    vscode.commands.registerCommand('aahp.showMetrics', () => {
      DashboardPanel.createOrShow(context.extensionUri, 'metrics')
    }),
    vscode.commands.registerCommand('aahp.refreshDashboard', () => {
      agentProvider.refresh()
      metricsProvider.refresh()
      DashboardPanel.refresh()
    }),
  )
}

export function deactivate() {}
