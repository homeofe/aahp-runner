import * as vscode from 'vscode'
import * as path from 'path'
import * as os from 'os'
import { AgentTreeProvider } from './agent-tree'
import { MetricsTreeProvider } from './metrics-tree'
import { DashboardPanel } from './dashboard-panel'
import { scanWorkspaceProjects } from './data-reader'

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
    // Open main dashboard
    vscode.commands.registerCommand('aahp.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri)
    }),

    // Show metrics tab
    vscode.commands.registerCommand('aahp.showMetrics', () => {
      DashboardPanel.createOrShow(context.extensionUri, 'metrics')
    }),

    // Refresh everything
    vscode.commands.registerCommand('aahp.refreshDashboard', () => {
      agentProvider.refresh()
      metricsProvider.refresh()
      DashboardPanel.refresh()
      vscode.window.showInformationMessage('AAHP Dashboard refreshed.')
    }),

    // Fix a single task with Claude CLI
    vscode.commands.registerCommand('aahp.fixTask', (projectPath?: string, taskId?: string, taskTitle?: string) => {
      if (!projectPath || !taskId || !taskTitle) {
        vscode.window.showWarningMessage('Missing task information. Use the dashboard to fix tasks.')
        return
      }
      launchClaudeForTask(projectPath, taskId, taskTitle)
    }),

    // Fix ALL open tasks across all projects
    vscode.commands.registerCommand('aahp.fixAllTasks', () => {
      fixAllOpenTasks()
    }),

    // Run aahp-runner agent on a specific project
    vscode.commands.registerCommand('aahp.runProject', (projectPath?: string, projectName?: string) => {
      if (!projectPath) {
        vscode.window.showWarningMessage('No project path provided.')
        return
      }
      runProjectAgent(projectPath, projectName ?? path.basename(projectPath))
    }),

    // Open project folder in new window
    vscode.commands.registerCommand('aahp.openProjectFolder', (projectPath?: string) => {
      if (!projectPath) return
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), { forceNewWindow: true })
    }),

    // Open MANIFEST.json in editor
    vscode.commands.registerCommand('aahp.openManifest', (manifestPath?: string) => {
      if (!manifestPath) return
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(manifestPath))
    }),

    // View today's log for a project
    vscode.commands.registerCommand('aahp.viewLogs', (repoName?: string) => {
      if (!repoName) return
      const stamp = new Date().toISOString().slice(0, 10)
      const logPath = path.join(os.homedir(), '.aahp', 'logs', `${repoName}-${stamp}.log`)
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(logPath))
    }),
  )
}

/** Open a new terminal running Claude CLI with a prompt to fix the given task */
function launchClaudeForTask(projectPath: string, taskId: string, taskTitle: string) {
  const terminalName = `Claude: Fix [${taskId}]`

  // Escape double quotes in the prompt
  const prompt = `Fix task ${taskId}: ${taskTitle}`.replace(/"/g, '\\"')

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: projectPath,
    iconPath: new vscode.ThemeIcon('tools'),
  })
  terminal.show()
  terminal.sendText(`claude "${prompt}"`)

  vscode.window.showInformationMessage(`Launched Claude to fix [${taskId}] in ${path.basename(projectPath)}`)
}

/** Scan all workspace projects and launch Claude for every task with status "ready" */
function fixAllOpenTasks() {
  const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []
  const projects = scanWorkspaceProjects(folders)

  let taskCount = 0
  for (const p of projects) {
    const tasks = p.manifest.tasks ?? {}
    for (const [id, task] of Object.entries(tasks)) {
      if (task.status === 'ready') {
        launchClaudeForTask(p.repoPath, id, task.title)
        taskCount++
      }
    }
  }

  if (taskCount === 0) {
    vscode.window.showInformationMessage('No open tasks found across all projects.')
  } else {
    vscode.window.showInformationMessage(`Launched Claude for ${taskCount} open task(s) across ${projects.length} project(s).`)
  }
}

/** Run aahp-runner on a specific project */
function runProjectAgent(projectPath: string, projectName: string) {
  const terminal = vscode.window.createTerminal({
    name: `AAHP: ${projectName}`,
    cwd: projectPath,
    iconPath: new vscode.ThemeIcon('play'),
  })
  terminal.show()
  terminal.sendText('npx aahp-runner --once')
}

export function deactivate() {}
