import * as vscode from 'vscode'
import { readLiveSessions, readMetrics, computeSummary, readConfig, getLastLogLine } from './data-reader'

export class DashboardPanel {
  private static _panel: vscode.WebviewPanel | undefined
  private static _refreshInterval: ReturnType<typeof setInterval> | undefined

  static createOrShow(_extensionUri: vscode.Uri, _tab?: string) {
    if (DashboardPanel._panel) {
      DashboardPanel._panel.reveal(vscode.ViewColumn.One)
      DashboardPanel._updateContent()
      return
    }

    DashboardPanel._panel = vscode.window.createWebviewPanel(
      'aahpDashboard',
      'AAHP Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    )

    DashboardPanel._updateContent()

    // Auto-refresh every 3 seconds
    DashboardPanel._refreshInterval = setInterval(() => {
      DashboardPanel._updateContent()
    }, 3000)

    DashboardPanel._panel.onDidDispose(() => {
      if (DashboardPanel._refreshInterval) {
        clearInterval(DashboardPanel._refreshInterval)
        DashboardPanel._refreshInterval = undefined
      }
      DashboardPanel._panel = undefined
    })
  }

  static refresh() {
    DashboardPanel._updateContent()
  }

  private static _updateContent() {
    if (!DashboardPanel._panel) return

    const sessions = readLiveSessions()
    const metrics = readMetrics(200)
    const summary = computeSummary(metrics)
    const config = readConfig()
    const recent = metrics.slice(-20).reverse()

    // Build agent rows
    const agentRows = sessions.length > 0
      ? sessions.map(s => {
          const elapsed = s.startedAt
            ? Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000)
            : 0
          const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
          const lastLog = getLastLogLine(s.repoName)
          return `<tr>
            <td><span class="status-dot running"></span> ${esc(s.repoName)}</td>
            <td>[${esc(s.taskId)}] ${esc(s.taskTitle)}</td>
            <td>${esc(s.backend)}</td>
            <td>${elapsedStr}</td>
            <td class="log-line">${esc(lastLog)}</td>
          </tr>`
        }).join('\n')
      : '<tr><td colspan="5" class="empty">No agents currently running</td></tr>'

    // Build recent runs rows
    const recentRows = recent.length > 0
      ? recent.map(m => {
          const durStr = formatDuration(m.durationMs)
          const icon = m.success ? '<span class="status-dot done"></span>' : '<span class="status-dot failed"></span>'
          const cpuStr = m.cpuAvg !== undefined ? `${Math.round(m.cpuAvg)}%` : '-'
          const memStr = m.memPeakMB !== undefined ? `${m.memPeakMB}MB` : '-'
          return `<tr>
            <td>${icon} ${esc(m.repo)}</td>
            <td>[${esc(m.taskId)}]</td>
            <td>${esc(m.backend)}</td>
            <td>${durStr}</td>
            <td>${m.turns}</td>
            <td>${cpuStr}</td>
            <td>${memStr}</td>
            <td>${esc(m.timestamp.slice(0, 16).replace('T', ' '))}</td>
          </tr>`
        }).join('\n')
      : '<tr><td colspan="8" class="empty">No runs recorded yet</td></tr>'

    // Build per-repo summary rows
    const repoRows = Object.entries(summary.byRepo)
      .sort(([, a], [, b]) => b.runs - a.runs)
      .map(([repo, stats]) => {
        const rate = stats.runs > 0 ? Math.round((stats.successes / stats.runs) * 100) : 0
        const barWidth = Math.min(rate, 100)
        return `<tr>
          <td>${esc(repo)}</td>
          <td>${stats.runs}</td>
          <td>${stats.successes}</td>
          <td>
            <div class="bar-container">
              <div class="bar ${rate >= 80 ? 'bar-good' : rate >= 50 ? 'bar-warn' : 'bar-bad'}" style="width:${barWidth}%"></div>
              <span class="bar-label">${rate}%</span>
            </div>
          </td>
          <td>${formatDuration(stats.avgMs)}</td>
        </tr>`
      }).join('\n')

    DashboardPanel._panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  h2 { font-size: 1.1em; margin-top: 24px; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
  .summary { display: flex; gap: 24px; margin: 12px 0; }
  .stat { padding: 12px 16px; border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .stat-value { font-size: 1.8em; font-weight: bold; }
  .stat-label { font-size: 0.85em; opacity: 0.7; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th { text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--vscode-widget-border); font-weight: 600; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  tr:hover { background: var(--vscode-list-hoverBackground); }
  .empty { opacity: 0.5; font-style: italic; text-align: center; padding: 16px; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .status-dot.running { background: #4fc3f7; animation: pulse 1.5s infinite; }
  .status-dot.done { background: #66bb6a; }
  .status-dot.failed { background: #ef5350; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .log-line { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; font-size: 0.85em; }
  .bar-container { position: relative; width: 100px; height: 16px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; overflow: hidden; }
  .bar { height: 100%; border-radius: 3px; }
  .bar-good { background: #66bb6a; }
  .bar-warn { background: #ffa726; }
  .bar-bad { background: #ef5350; }
  .bar-label { position: absolute; top: 0; left: 4px; font-size: 0.75em; line-height: 16px; }
  .config-item { display: inline-block; margin-right: 16px; opacity: 0.7; font-size: 0.85em; }
</style>
</head>
<body>
  <h1>AAHP Dashboard</h1>
  <div class="config-item">Backend: ${esc(config.backend ?? 'auto')}</div>
  <div class="config-item">Timeout: ${config.timeoutMinutes ?? 10}m</div>
  <div class="config-item">Root: ${esc(config.rootDir ?? '(not set)')}</div>

  <div class="summary">
    <div class="stat">
      <div class="stat-value">${sessions.length}</div>
      <div class="stat-label">Running</div>
    </div>
    <div class="stat">
      <div class="stat-value">${summary.totalRuns}</div>
      <div class="stat-label">Total Runs</div>
    </div>
    <div class="stat">
      <div class="stat-value">${summary.successRate}%</div>
      <div class="stat-label">Success Rate</div>
    </div>
    <div class="stat">
      <div class="stat-value">${formatDuration(summary.avgDurationMs)}</div>
      <div class="stat-label">Avg Duration</div>
    </div>
  </div>

  <h2>Running Agents</h2>
  <table>
    <tr><th>Repo</th><th>Task</th><th>Backend</th><th>Elapsed</th><th>Last Log</th></tr>
    ${agentRows}
  </table>

  <h2>Repository Overview</h2>
  <table>
    <tr><th>Repo</th><th>Runs</th><th>OK</th><th>Success Rate</th><th>Avg Duration</th></tr>
    ${repoRows || '<tr><td colspan="5" class="empty">No data</td></tr>'}
  </table>

  <h2>Recent Runs</h2>
  <table>
    <tr><th>Repo</th><th>Task</th><th>Backend</th><th>Duration</th><th>Turns</th><th>CPU</th><th>Memory</th><th>Time</th></tr>
    ${recentRows}
  </table>
</body>
</html>`
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return remSec > 0 ? `${min}m${remSec}s` : `${min}m`
}
