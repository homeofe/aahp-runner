import * as vscode from 'vscode'
import { readLiveSessions, readMetrics, computeSummary, readConfig, getLastLogLine, scanWorkspaceProjects, type WorkspaceProject } from './data-reader'

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

    // Handle messages from the webview
    DashboardPanel._panel.webview.onDidReceiveMessage((msg) => {
      DashboardPanel._handleMessage(msg)
    })

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

  private static _handleMessage(msg: { command: string; [key: string]: string }) {
    switch (msg.command) {
      case 'fixTask':
        vscode.commands.executeCommand('aahp.fixTask', msg.projectPath, msg.taskId, msg.taskTitle)
        break
      case 'fixProjectTasks':
        DashboardPanel._fixProjectTasks(msg.projectPath)
        break
      case 'fixAllTasks':
        vscode.commands.executeCommand('aahp.fixAllTasks')
        break
      case 'runProject':
        vscode.commands.executeCommand('aahp.runProject', msg.projectPath, msg.projectName)
        break
      case 'openFolder':
        vscode.commands.executeCommand('aahp.openProjectFolder', msg.projectPath)
        break
      case 'openManifest':
        vscode.commands.executeCommand('aahp.openManifest', msg.manifestPath)
        break
      case 'viewLogs':
        vscode.commands.executeCommand('aahp.viewLogs', msg.repoName)
        break
      case 'refresh':
        vscode.commands.executeCommand('aahp.refreshDashboard')
        break
    }
  }

  private static _fixProjectTasks(projectPath: string) {
    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []
    const projects = scanWorkspaceProjects(folders)
    const project = projects.find(p => p.repoPath === projectPath)
    if (!project) {
      vscode.window.showWarningMessage('Project not found.')
      return
    }

    const tasks = project.manifest.tasks ?? {}
    let count = 0
    for (const [id, task] of Object.entries(tasks)) {
      if (task.status === 'ready') {
        vscode.commands.executeCommand('aahp.fixTask', projectPath, id, task.title)
        count++
      }
    }

    if (count === 0) {
      vscode.window.showInformationMessage(`No open tasks in ${project.name}.`)
    } else {
      vscode.window.showInformationMessage(`Launched Claude for ${count} task(s) in ${project.name}.`)
    }
  }

  private static _updateContent() {
    if (!DashboardPanel._panel) return

    const sessions = readLiveSessions()
    const metrics = readMetrics(200)
    const summary = computeSummary(metrics)
    const config = readConfig()
    const recent = metrics.slice(-20).reverse()
    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []
    const wsProjects = scanWorkspaceProjects(folders)

    const nonce = getNonce()

    // Count total open tasks across all projects
    let totalOpenTasks = 0
    for (const p of wsProjects) {
      const tasks = p.manifest.tasks ?? {}
      totalOpenTasks += Object.values(tasks).filter(t => t.status === 'ready').length
    }

    const projectsHtml = buildProjectsHtml(wsProjects)
    const agentRows = buildAgentRows(sessions)
    const repoRows = buildRepoRows(summary)
    const recentRows = buildRecentRows(recent)

    DashboardPanel._panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
    margin: 0;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--vscode-widget-border);
    background: var(--vscode-sideBar-background);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .header h1 { font-size: 1.3em; margin: 0; }
  .header-actions { display: flex; gap: 8px; align-items: center; }

  .content { padding: 16px 20px; }

  /* Buttons */
  .btn {
    padding: 6px 14px;
    border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-size: 0.85em;
    font-family: inherit;
    white-space: nowrap;
  }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
    font-weight: 600;
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-sm {
    padding: 2px 8px;
    font-size: 0.8em;
    border-radius: 3px;
  }
  .btn-icon {
    padding: 4px 8px;
    font-size: 0.8em;
    border-radius: 3px;
  }
  .btn-danger {
    background: #ef5350;
    color: #fff;
    border-color: #ef5350;
  }

  /* Config bar */
  .config-bar {
    display: flex;
    gap: 16px;
    padding: 8px 20px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    font-size: 0.85em;
    opacity: 0.8;
    flex-wrap: wrap;
  }

  /* Summary stats */
  .summary { display: flex; gap: 16px; margin: 16px 0; flex-wrap: wrap; }
  .stat {
    padding: 12px 16px;
    border-radius: 6px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    min-width: 100px;
    text-align: center;
  }
  .stat-value { font-size: 1.8em; font-weight: bold; }
  .stat-label { font-size: 0.85em; opacity: 0.7; }

  /* Section headers */
  h2 {
    font-size: 1.1em;
    margin-top: 28px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
    padding-bottom: 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 .section-actions { display: flex; gap: 6px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 2px solid var(--vscode-widget-border);
    font-weight: 600;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.8;
  }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  tr:hover { background: var(--vscode-list-hoverBackground); }
  .empty { opacity: 0.5; font-style: italic; text-align: center; padding: 16px; }

  /* Status indicators */
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .status-dot.running { background: #4fc3f7; animation: pulse 1.5s infinite; }
  .status-dot.done { background: #66bb6a; }
  .status-dot.failed { background: #ef5350; }
  .status-dot.ready { background: #ffa726; }
  .status-dot.in-progress { background: #4fc3f7; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  .log-line { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; font-size: 0.85em; }

  /* Progress bars */
  .bar-container { position: relative; width: 100px; height: 16px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; overflow: hidden; }
  .bar { height: 100%; border-radius: 3px; }
  .bar-good { background: #66bb6a; }
  .bar-warn { background: #ffa726; }
  .bar-bad { background: #ef5350; }
  .bar-label { position: absolute; top: 0; left: 4px; font-size: 0.75em; line-height: 16px; }

  /* Project cards */
  .project-card {
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    margin-bottom: 12px;
    overflow: hidden;
  }
  .project-header {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    cursor: pointer;
    gap: 12px;
    background: var(--vscode-editor-inactiveSelectionBackground);
  }
  .project-header:hover { background: var(--vscode-list-hoverBackground); }
  .project-expand { font-size: 0.8em; opacity: 0.6; transition: transform 0.2s; }
  .project-expand.open { transform: rotate(90deg); }
  .project-name { font-weight: 600; min-width: 120px; }
  .project-phase {
    font-size: 0.8em;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .project-stats { font-size: 0.85em; opacity: 0.8; flex: 1; }
  .project-actions { display: flex; gap: 4px; }

  /* Task list inside project card */
  .task-list { display: none; border-top: 1px solid var(--vscode-widget-border); }
  .task-list.visible { display: block; }
  .task-row {
    display: flex;
    align-items: center;
    padding: 6px 14px 6px 32px;
    gap: 12px;
    border-bottom: 1px solid var(--vscode-widget-border);
    font-size: 0.9em;
  }
  .task-row:last-child { border-bottom: none; }
  .task-row:hover { background: var(--vscode-list-hoverBackground); }
  .task-row.clickable { cursor: pointer; }
  .task-id { font-family: monospace; font-size: 0.85em; opacity: 0.7; min-width: 60px; }
  .task-title { flex: 1; }
  .task-priority {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .task-priority.high { background: #ef5350; color: #fff; }
  .task-priority.medium { background: #ffa726; color: #000; }
  .task-priority.low { background: var(--vscode-editor-inactiveSelectionBackground); }
  .task-status { font-size: 0.8em; min-width: 70px; }

  /* Keyboard shortcut hints */
  .kbd {
    display: inline-block;
    padding: 2px 6px;
    font-size: 0.75em;
    font-family: monospace;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    opacity: 0.6;
  }

  /* Empty project state */
  .no-projects {
    text-align: center;
    padding: 32px;
    opacity: 0.6;
  }
</style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <h1>AAHP Dashboard</h1>
    <div class="header-actions">
      <span class="kbd">Ctrl+Alt+A</span>
      <button class="btn btn-primary" id="fixAllBtn" ${totalOpenTasks === 0 ? 'disabled' : ''}>
        Fix All Open Tasks (${totalOpenTasks})
      </button>
      <span class="kbd">Ctrl+Alt+F</span>
      <button class="btn" id="refreshBtn">Refresh</button>
      <span class="kbd">Ctrl+Alt+R</span>
    </div>
  </div>

  <!-- Config bar -->
  <div class="config-bar">
    <span>Backend: <strong>${esc(config.backend ?? 'auto')}</strong></span>
    <span>Timeout: <strong>${config.timeoutMinutes ?? 10}m</strong></span>
    <span>Root: <strong>${esc(config.rootDir ?? '(not set)')}</strong></span>
    <span>Updated: <strong>${new Date().toLocaleTimeString()}</strong></span>
  </div>

  <div class="content">
    <!-- Summary stats -->
    <div class="summary">
      <div class="stat">
        <div class="stat-value">${wsProjects.length}</div>
        <div class="stat-label">Projects</div>
      </div>
      <div class="stat">
        <div class="stat-value">${totalOpenTasks}</div>
        <div class="stat-label">Open Tasks</div>
      </div>
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

    <!-- AAHP Projects with tasks -->
    <h2>
      <span>AAHP Projects (${wsProjects.length})</span>
      <div class="section-actions">
        <button class="btn btn-sm" id="expandAllBtn">Expand All</button>
        <button class="btn btn-sm" id="collapseAllBtn">Collapse All</button>
      </div>
    </h2>
    ${projectsHtml}

    <!-- Running Agents -->
    <h2>Running Agents (${sessions.length})</h2>
    <table>
      <tr><th>Repo</th><th>Task</th><th>Backend</th><th>Elapsed</th><th>Last Log</th></tr>
      ${agentRows}
    </table>

    <!-- Repository Overview -->
    <h2>Repository Overview</h2>
    <table>
      <tr><th>Repo</th><th>Runs</th><th>OK</th><th>Success Rate</th><th>Avg Duration</th></tr>
      ${repoRows || '<tr><td colspan="5" class="empty">No data</td></tr>'}
    </table>

    <!-- Recent Runs -->
    <h2>Recent Runs</h2>
    <table>
      <tr><th>Repo</th><th>Task</th><th>Backend</th><th>Duration</th><th>Turns</th><th>CPU</th><th>Memory</th><th>Time</th></tr>
      ${recentRows}
    </table>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Fix All Open Tasks button
    document.getElementById('fixAllBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'fixAllTasks' });
    });

    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    // Expand / Collapse all
    document.getElementById('expandAllBtn').addEventListener('click', () => {
      document.querySelectorAll('.task-list').forEach(el => el.classList.add('visible'));
      document.querySelectorAll('.project-expand').forEach(el => el.classList.add('open'));
    });
    document.getElementById('collapseAllBtn').addEventListener('click', () => {
      document.querySelectorAll('.task-list').forEach(el => el.classList.remove('visible'));
      document.querySelectorAll('.project-expand').forEach(el => el.classList.remove('open'));
    });

    // Toggle task list for a project
    document.querySelectorAll('.project-header').forEach(header => {
      header.addEventListener('click', (e) => {
        // Don't toggle if clicking a button
        if (e.target.closest('.project-actions')) return;
        const card = header.closest('.project-card');
        const taskList = card.querySelector('.task-list');
        const arrow = header.querySelector('.project-expand');
        if (taskList) taskList.classList.toggle('visible');
        if (arrow) arrow.classList.toggle('open');
      });
    });

    // Fix single task buttons
    document.querySelectorAll('[data-action="fixTask"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          command: 'fixTask',
          projectPath: btn.dataset.projectPath,
          taskId: btn.dataset.taskId,
          taskTitle: btn.dataset.taskTitle,
        });
      });
    });

    // Fix all tasks for a project
    document.querySelectorAll('[data-action="fixProjectTasks"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          command: 'fixProjectTasks',
          projectPath: btn.dataset.projectPath,
        });
      });
    });

    // Run agent on project
    document.querySelectorAll('[data-action="runProject"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          command: 'runProject',
          projectPath: btn.dataset.projectPath,
          projectName: btn.dataset.projectName,
        });
      });
    });

    // Open folder
    document.querySelectorAll('[data-action="openFolder"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          command: 'openFolder',
          projectPath: btn.dataset.projectPath,
        });
      });
    });

    // Open MANIFEST
    document.querySelectorAll('[data-action="openManifest"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          command: 'openManifest',
          manifestPath: btn.dataset.manifestPath,
        });
      });
    });

    // View logs
    document.querySelectorAll('[data-action="viewLogs"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          command: 'viewLogs',
          repoName: btn.dataset.repoName,
        });
      });
    });

    // Clickable task rows (ready tasks)
    document.querySelectorAll('.task-row.clickable').forEach(row => {
      row.addEventListener('click', () => {
        vscode.postMessage({
          command: 'fixTask',
          projectPath: row.dataset.projectPath,
          taskId: row.dataset.taskId,
          taskTitle: row.dataset.taskTitle,
        });
      });
    });
  </script>
</body>
</html>`
  }
}

// ── HTML builders ────────────────────────────────────────────────────────────

function buildProjectsHtml(projects: WorkspaceProject[]): string {
  if (projects.length === 0) {
    return '<div class="no-projects">No AAHP projects found. Open a workspace containing <code>.ai/handoff/MANIFEST.json</code></div>'
  }

  return projects.map(p => {
    const tasks = p.manifest.tasks ?? {}
    const entries = Object.entries(tasks)
    const ready = entries.filter(([, t]) => t.status === 'ready')
    const inProgress = entries.filter(([, t]) => t.status === 'in_progress')
    const done = entries.filter(([, t]) => t.status === 'done')
    const total = entries.length

    const phase = p.manifest.last_session?.phase ?? 'idle'

    // Build task rows
    const taskRowsHtml = entries.length > 0
      ? entries
          .sort((a, b) => {
            const order: Record<string, number> = { ready: 0, in_progress: 1, done: 2 }
            return (order[a[1].status] ?? 3) - (order[b[1].status] ?? 3)
          })
          .map(([id, task]) => {
            const isReady = task.status === 'ready'
            const statusDot = task.status === 'ready' ? 'ready'
              : task.status === 'in_progress' ? 'in-progress'
              : 'done'
            return `<div class="task-row ${isReady ? 'clickable' : ''}"
                data-project-path="${escAttr(p.repoPath)}"
                data-task-id="${escAttr(id)}"
                data-task-title="${escAttr(task.title)}">
              <span class="task-id"><span class="status-dot ${statusDot}"></span>${esc(id)}</span>
              <span class="task-title">${esc(task.title)}</span>
              <span class="task-priority ${task.priority}">${esc(task.priority)}</span>
              <span class="task-status">${esc(task.status)}</span>
              ${isReady
                ? `<button class="btn btn-sm btn-primary" data-action="fixTask"
                    data-project-path="${escAttr(p.repoPath)}"
                    data-task-id="${escAttr(id)}"
                    data-task-title="${escAttr(task.title)}">Fix</button>`
                : ''}
            </div>`
          }).join('\n')
      : '<div class="task-row"><span class="empty">No tasks defined</span></div>'

    return `<div class="project-card">
      <div class="project-header">
        <span class="project-expand">&#9654;</span>
        <span class="project-name">${esc(p.name)}</span>
        <span class="project-phase">${esc(phase)}</span>
        <span class="project-stats">
          ${ready.length} ready / ${inProgress.length} active / ${done.length} done / ${total} total
        </span>
        <div class="project-actions">
          ${ready.length > 0
            ? `<button class="btn btn-sm btn-primary" data-action="fixProjectTasks"
                data-project-path="${escAttr(p.repoPath)}">Fix All (${ready.length})</button>`
            : ''}
          <button class="btn btn-sm btn-icon" data-action="runProject"
            data-project-path="${escAttr(p.repoPath)}"
            data-project-name="${escAttr(p.name)}" title="Run aahp-runner">Run</button>
          <button class="btn btn-sm btn-icon" data-action="openFolder"
            data-project-path="${escAttr(p.repoPath)}" title="Open folder in new window">Open</button>
          <button class="btn btn-sm btn-icon" data-action="openManifest"
            data-manifest-path="${escAttr(p.manifestPath)}" title="Open MANIFEST.json">MANIFEST</button>
          <button class="btn btn-sm btn-icon" data-action="viewLogs"
            data-repo-name="${escAttr(p.name)}" title="View today's log">Logs</button>
        </div>
      </div>
      <div class="task-list">
        ${taskRowsHtml}
      </div>
    </div>`
  }).join('\n')
}

function buildAgentRows(sessions: ReturnType<typeof readLiveSessions>): string {
  if (sessions.length === 0) {
    return '<tr><td colspan="5" class="empty">No agents currently running</td></tr>'
  }

  return sessions.map(s => {
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
}

function buildRepoRows(summary: ReturnType<typeof computeSummary>): string {
  const entries = Object.entries(summary.byRepo).sort(([, a], [, b]) => b.runs - a.runs)
  if (entries.length === 0) return ''

  return entries.map(([repo, stats]) => {
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
}

function buildRecentRows(recent: ReturnType<typeof readMetrics>): string {
  if (recent.length === 0) {
    return '<tr><td colspan="8" class="empty">No runs recorded yet</td></tr>'
  }

  return recent.map(m => {
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
}

// ── Utilities ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return remSec > 0 ? `${min}m${remSec}s` : `${min}m`
}

function getNonce(): string {
  let text = ''
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
