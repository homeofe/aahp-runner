import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendAlert } from './alerting.js'
import type { AlertConfig } from './scheduler.js'

// Mock global fetch
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

// ── sendAlert ────────────────────────────────────────────────────────────────

describe('sendAlert', () => {
  it('does nothing when config is undefined', async () => {
    await sendAlert(undefined, 'all_done', { summary: 'test' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing when config has no webhook or slack', async () => {
    const config: AlertConfig = {}
    await sendAlert(config, 'all_done', { summary: 'test' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends to webhook URL when configured', async () => {
    const config: AlertConfig = { webhook: 'https://example.com/hook' }
    await sendAlert(config, 'all_done', { summary: 'test', totalDone: 3, totalFailed: 1 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://example.com/hook')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body)
    expect(body.event).toBe('all_done')
    expect(body.totalDone).toBe(3)
    expect(body.totalFailed).toBe(1)
    expect(body.timestamp).toBeDefined()
  })

  it('sends to Slack webhook with blocks format', async () => {
    const config: AlertConfig = { slack: 'https://hooks.slack.com/test' }
    await sendAlert(config, 'agent_failed', { repo: 'my-repo', taskId: 'T-001' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://hooks.slack.com/test')

    const body = JSON.parse(opts.body)
    expect(body.blocks).toBeDefined()
    expect(body.blocks[0].type).toBe('section')
    expect(body.blocks[0].text.text).toContain('my-repo')
  })

  it('sends to both webhook and Slack when both configured', async () => {
    const config: AlertConfig = {
      webhook: 'https://example.com/hook',
      slack: 'https://hooks.slack.com/test',
    }
    await sendAlert(config, 'run_complete', { repo: 'my-repo', success: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('respects event filter - skips disabled events', async () => {
    const config: AlertConfig = {
      webhook: 'https://example.com/hook',
      events: ['agent_failed'],  // only agent_failed enabled
    }
    await sendAlert(config, 'all_done', { summary: 'test' })
    expect(fetchMock).not.toHaveBeenCalled()

    await sendAlert(config, 'agent_failed', { repo: 'test' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not throw on fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('network error'))
    const config: AlertConfig = { webhook: 'https://example.com/hook' }

    // Should not throw
    await expect(sendAlert(config, 'all_done', { summary: 'test' })).resolves.toBeUndefined()
  })

  it('includes timestamp in payload', async () => {
    const config: AlertConfig = { webhook: 'https://example.com/hook' }
    const before = new Date().toISOString().slice(0, 10)
    await sendAlert(config, 'run_complete', { repo: 'test' })

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.timestamp).toContain(before)
  })
})
