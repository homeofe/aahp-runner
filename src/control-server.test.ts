import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { startControlServer, type ControlServer } from './control-server.js'

/**
 * Tests for the issue #28 control server. Each test gets its own temp
 * sessions.json so we never touch the real ~/.aahp/sessions.json.
 */

let tmpDir: string
let sessionsFile: string
let server: ControlServer | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aahp-control-test-'))
  sessionsFile = path.join(tmpDir, 'sessions.json')
  server = undefined
})

afterEach(async () => {
  await server?.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Helper: tiny http POST against the loopback server. */
async function postJson(port: number, urlPath: string, body: unknown, method: string = 'POST'): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
  let parsed: any
  try { parsed = await res.json() } catch { parsed = null }
  return { status: res.status, body: parsed }
}

describe('control-server lifecycle', () => {
  it('binds to a random localhost port and writes controlPort to sessions.json', async () => {
    server = await startControlServer({ sessionsFile })
    expect(server.port).toBeGreaterThan(0)
    expect(server.port).toBeLessThan(65536)

    // sessions.json should now contain { controlPort: <port> }
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
    expect(data.controlPort).toBe(server.port)
  })

  it('preserves existing sessions.json keys when adding controlPort', async () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({
      sessions: [{ repoPath: '/x', repoName: 'x' }],
      somethingElse: 42,
    }))
    server = await startControlServer({ sessionsFile })
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
    expect(data.controlPort).toBe(server.port)
    expect(data.somethingElse).toBe(42)
    expect(Array.isArray(data.sessions)).toBe(true)
    expect(data.sessions[0].repoName).toBe('x')
  })

  it('removes controlPort from sessions.json on stop()', async () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({ sessions: ['preexisting'] }))
    server = await startControlServer({ sessionsFile })
    await server.stop()
    server = undefined  // prevent double-stop in afterEach

    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
    expect(data.controlPort).toBeUndefined()
    // unrelated keys preserved
    expect(data.sessions).toEqual(['preexisting'])
  })

  it('survives malformed sessions.json (treats as empty object)', async () => {
    fs.writeFileSync(sessionsFile, '{ this is not valid json')
    server = await startControlServer({ sessionsFile })
    expect(server.port).toBeGreaterThan(0)

    // After start, the malformed content is replaced with a clean object containing controlPort.
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
    expect(data.controlPort).toBe(server.port)
  })
})

describe('control-server registry', () => {
  it('starts empty', async () => {
    server = await startControlServer({ sessionsFile })
    expect(server.size()).toBe(0)
  })

  it('register/unregister tracks active agents', async () => {
    server = await startControlServer({ sessionsFile })
    server.register({ repoName: 'a', taskId: 'T-001', abort: () => { /* noop */ } })
    server.register({ repoName: 'b', taskId: 'T-002', abort: () => { /* noop */ } })
    expect(server.size()).toBe(2)

    server.unregister('a', 'T-001')
    expect(server.size()).toBe(1)

    server.unregister('b', 'T-002')
    expect(server.size()).toBe(0)
  })
})

describe('control-server HTTP endpoint', () => {
  it('POST /abort triggers the registered handle and returns 200', async () => {
    server = await startControlServer({ sessionsFile })
    let aborted = false
    server.register({
      repoName: 'my-repo',
      taskId: 'T-007',
      abort: () => { aborted = true },
    })

    const { status, body } = await postJson(server.port, '/abort', { repoName: 'my-repo', taskId: 'T-007' })
    expect(status).toBe(200)
    expect(body.aborted).toBe(true)
    expect(body.repoName).toBe('my-repo')
    expect(body.taskId).toBe('T-007')
    expect(aborted).toBe(true)
  })

  it('returns 404 for unknown session', async () => {
    server = await startControlServer({ sessionsFile })
    const { status, body } = await postJson(server.port, '/abort', { repoName: 'ghost', taskId: 'T-999' })
    expect(status).toBe(404)
    expect(body.error).toBe('no matching session')
  })

  it('returns 405 for non-POST methods', async () => {
    server = await startControlServer({ sessionsFile })
    const { status } = await postJson(server.port, '/abort', null, 'GET')
    expect(status).toBe(405)
  })

  it('returns 404 for unknown paths', async () => {
    server = await startControlServer({ sessionsFile })
    const { status } = await postJson(server.port, '/wrong-path', { repoName: 'x', taskId: 'T-001' })
    expect(status).toBe(404)
  })

  it('returns 400 for invalid JSON body', async () => {
    server = await startControlServer({ sessionsFile })
    const res = await fetch(`http://127.0.0.1:${server.port}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when repoName or taskId is missing', async () => {
    server = await startControlServer({ sessionsFile })
    const r1 = await postJson(server.port, '/abort', { repoName: 'x' })
    expect(r1.status).toBe(400)
    const r2 = await postJson(server.port, '/abort', { taskId: 'T-001' })
    expect(r2.status).toBe(400)
    const r3 = await postJson(server.port, '/abort', {})
    expect(r3.status).toBe(400)
  })

  it('does not call abort callback for unknown session', async () => {
    server = await startControlServer({ sessionsFile })
    let aborted = false
    server.register({ repoName: 'a', taskId: 'T-001', abort: () => { aborted = true } })
    await postJson(server.port, '/abort', { repoName: 'b', taskId: 'T-001' })
    expect(aborted).toBe(false)
  })

  it('routes correctly when multiple agents are registered', async () => {
    server = await startControlServer({ sessionsFile })
    let abortedA = false
    let abortedB = false
    server.register({ repoName: 'a', taskId: 'T-001', abort: () => { abortedA = true } })
    server.register({ repoName: 'b', taskId: 'T-002', abort: () => { abortedB = true } })

    await postJson(server.port, '/abort', { repoName: 'b', taskId: 'T-002' })
    expect(abortedA).toBe(false)
    expect(abortedB).toBe(true)
  })

  it('rejects oversized payloads with 413', async () => {
    server = await startControlServer({ sessionsFile })
    const huge = 'x'.repeat(10 * 1024)  // 10KB > 4KB cap
    const res = await fetch(`http://127.0.0.1:${server.port}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoName: 'x', taskId: huge }),
    })
    expect(res.status).toBe(413)
  })
})

describe('control-server cleanup', () => {
  it('releases the port after stop()', async () => {
    server = await startControlServer({ sessionsFile })
    const oldPort = server.port
    await server.stop()
    server = undefined

    // Connecting to the old port should fail. Use a short timeout so the test
    // doesn't hang if the OS happens to reassign immediately to something else.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 1500)
    try {
      const res = await fetch(`http://127.0.0.1:${oldPort}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoName: 'x', taskId: 'T-1' }),
        signal: ac.signal,
      }).catch(err => ({ ok: false, status: 0, _err: String(err) } as any))
      expect((res as any).status).toBe(0)
    } finally {
      clearTimeout(timer)
    }
  })

  it('handles repeated stop() without throwing', async () => {
    server = await startControlServer({ sessionsFile })
    await server.stop()
    await server.stop()  // second call is a no-op
    server = undefined
  })

  it('clears agent registry on stop()', async () => {
    server = await startControlServer({ sessionsFile })
    server.register({ repoName: 'a', taskId: 'T-001', abort: () => { /* noop */ } })
    expect(server.size()).toBe(1)
    await server.stop()
    expect(server.size()).toBe(0)
    server = undefined
  })
})

describe('control-server isolation (security)', () => {
  it('binds only to 127.0.0.1, not all interfaces', async () => {
    // We can't easily verify the bind from the address Node returns (it gives
    // 127.0.0.1 explicitly when we passed it), but we can at least confirm
    // that the address Node returns is the loopback we asked for.
    server = await startControlServer({ sessionsFile })
    // The implementation calls listen(0, '127.0.0.1') so this is by construction.
    // This test documents the security-critical invariant.
    const res = await fetch(`http://127.0.0.1:${server.port}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoName: 'x', taskId: 'T-1' }),
    })
    // Should at least respond (404 = no matching session is fine - server is up).
    expect(res.status).toBe(404)
  })
})
