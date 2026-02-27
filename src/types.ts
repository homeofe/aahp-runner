// AAHP v3 types shared across the runner
export interface AahpTask {
  title: string
  status: 'ready' | 'in_progress' | 'done' | 'blocked' | 'pending'
  priority: 'high' | 'medium' | 'low'
  depends_on: string[]
  created: string
  completed?: string
  notes?: string
}

export interface AahpManifest {
  aahp_version?: string
  version?: string
  project: string
  last_session: {
    agent: string
    session_id?: string
    timestamp: string
    commit: string
    phase: string
    duration_minutes: number
  }
  files: Record<string, { checksum: string; updated: string; lines: number; summary: string }>
  quick_context: string
  token_budget: Record<string, number>
  next_task_id?: number
  tasks?: Record<string, AahpTask>
}

export interface AahpProject {
  name: string
  repoPath: string
  handoffDir: string
  manifest: AahpManifest
  readyTasks: Array<[string, AahpTask]>
  activeTasks: Array<[string, AahpTask]>
}
