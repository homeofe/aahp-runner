import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Issue #28: HTTP control surface for `aahp run`.
 *
 * Exposes a tiny localhost-only HTTP endpoint that the aahp-hub can POST to
 * in order to abort a running agent. The endpoint is bound to `127.0.0.1:0`
 * (random port); the assigned port is written to `~/.aahp/sessions.json`
 * under the top-level `controlPort` key so the hub can discover it without
 * any new wiring.
 *
 * Security:
 *   - 127.0.0.1 only. NEVER bind to 0.0.0.0.
 *   - No auth at this layer; anyone with shell access can already kill the
 *     process. The hub should be served on a trusted network.
 *   - Only POST /abort is accepted. Everything else returns 405 / 404.
 */

const SESSIONS_FILE = path.join(os.homedir(), '.aahp', 'sessions.json')

/** A handle that the run loop registers for each in-flight agent. */
export interface AgentHandle {
  /** Repository name (matches RunMetric.repo). */
  repoName: string
  /** Task ID (e.g. "T-001"). */
  taskId: string
  /** Triggers an abort. Implementations should be idempotent. */
  abort: () => void
}

export interface AbortRequestBody {
  repoName?: string
  taskId?: string
}

export interface ControlServer {
  /** TCP port the server is listening on (assigned by the OS). */
  port: number
  /** Register an in-flight agent so it can be aborted via the endpoint. */
  register(handle: AgentHandle): void
  /** Remove a finished agent from the registry. */
  unregister(repoName: string, taskId: string): void
  /** Number of currently registered agents (for tests + diagnostics). */
  size(): number
  /** Shut down the HTTP server and remove `controlPort` from sessions.json. */
  stop(): Promise<void>
}

export interface StartControlServerOptions {
  /** Override the sessions.json path (used by tests). */
  sessionsFile?: string
}

/**
 * Read sessions.json (best-effort). Returns `{}` when the file is missing
 * or malformed - the orchestrator may not have populated it yet.
 */
function readSessionsFile(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Atomically merge keys into sessions.json without dropping existing data. */
function mergeIntoSessionsFile(file: string, patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const current = readSessionsFile(file)
  const next = { ...current, ...patch }
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
}

/** Remove specific keys from sessions.json (preserves the rest). */
function removeFromSessionsFile(file: string, keys: string[]): void {
  if (!fs.existsSync(file)) return
  const current = readSessionsFile(file)
  for (const k of keys) delete current[k]
  fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
}

/** Build the Map key used to look up registered agents. */
function key(repoName: string, taskId: string): string {
  return `${repoName}|${taskId}`
}

/**
 * Start the control HTTP server and write `controlPort` into sessions.json.
 *
 * The returned `ControlServer` is the public surface for the run loop:
 * register agents while they are alive, unregister when they finish, and
 * call `stop()` when `aahp run` exits.
 */
export async function startControlServer(opts: StartControlServerOptions = {}): Promise<ControlServer> {
  const sessionsFile = opts.sessionsFile ?? SESSIONS_FILE
  const agents = new Map<string, AgentHandle>()

  const server = http.createServer((req, res) => {
    // ── Method/route guard ────────────────────────────────────────────────
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    if (req.url !== '/abort') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    // ── Body parser (cap at 4KB to defend against unbounded reads) ────────
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > 4 * 1024) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      let body: AbortRequestBody
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as AbortRequestBody
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body' }))
        return
      }

      const { repoName, taskId } = body
      if (typeof repoName !== 'string' || typeof taskId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'repoName and taskId are required' }))
        return
      }

      const handle = agents.get(key(repoName, taskId))
      if (!handle) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no matching session' }))
        return
      }

      try {
        handle.abort()
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'abort failed', detail: String(err).slice(0, 200) }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ aborted: true, repoName, taskId }))
    })
    req.on('error', () => {
      // Connection dropped mid-request. Nothing to do.
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // CRITICAL: 127.0.0.1 only. Never 0.0.0.0.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('control server address unavailable')
  }
  const port = addr.port

  // Advertise our port via sessions.json so the hub can find us.
  mergeIntoSessionsFile(sessionsFile, { controlPort: port })

  return {
    port,
    register(handle: AgentHandle): void {
      agents.set(key(handle.repoName, handle.taskId), handle)
    },
    unregister(repoName: string, taskId: string): void {
      agents.delete(key(repoName, taskId))
    },
    size(): number {
      return agents.size
    },
    async stop(): Promise<void> {
      // Drop our advertised port first so the hub stops trying to reach us
      // even if close() takes a moment to actually release the socket.
      removeFromSessionsFile(sessionsFile, ['controlPort'])
      agents.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Force-close any keep-alive connections so close() resolves promptly.
        server.closeAllConnections?.()
      })
    },
  }
}
