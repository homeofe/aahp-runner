/**
 * Tests for retry logic with exponential backoff (T-008)
 *
 * Covers:
 *  - withRetry retries on failure up to maxRetries
 *  - Exponential backoff delay schedule: baseDelayMs * 2^(attempt-1)
 *  - Does not retry when function succeeds on first try
 *  - Returns result immediately on first success (no unnecessary retries)
 *  - Throws last error after exhausting retries
 *  - Does NOT retry non-retryable errors (no backend, auth errors)
 *  - onRetry callback receives correct attempt number, error, and delay
 *  - Configurable maxRetries and baseDelayMs
 *  - Default values: maxRetries=3, baseDelayMs=1000
 *  - Retry on success=false result (non-throwing failure)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRetry, type RetryOptions } from './agent.js'

// Use fake timers so delays don't slow down tests
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Helper: run withRetry and advance fake timers automatically
async function runWithFakeTimers<T extends { success: boolean }>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const promise = withRetry(fn, opts)
  // Drain all microtasks + advance timers multiple times to cover all delays
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    vi.runAllTimers()
    await Promise.resolve()
  }
  return promise
}

describe('withRetry - basic success', () => {
  it('returns result immediately when fn succeeds on first try', async () => {
    const fn = vi.fn().mockResolvedValue({ success: true, taskId: 'T-001', turns: 1, committed: true, summary: 'ok', logFile: '' })

    const result = await runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 100 })

    expect(result.success).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not call onRetry when fn succeeds on first try', async () => {
    const onRetry = vi.fn()
    const fn = vi.fn().mockResolvedValue({ success: true, taskId: 'T-001', turns: 1, committed: true, summary: '', logFile: '' })

    await runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 100, onRetry })

    expect(onRetry).not.toHaveBeenCalled()
  })
})

describe('withRetry - retries on failure', () => {
  it('retries up to maxRetries times when fn throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('transient error'))

    await expect(
      runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('transient error')

    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('returns success on the Nth attempt when earlier attempts fail', async () => {
    let calls = 0
    const fn = vi.fn().mockImplementation(() => {
      calls++
      if (calls < 3) return Promise.reject(new Error('not yet'))
      return Promise.resolve({ success: true, taskId: 'T-001', turns: 1, committed: true, summary: 'done', logFile: '' })
    })

    const result = await runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 10 })

    expect(result.success).toBe(true)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('retries on success=false result (non-throwing failure)', async () => {
    const failure = { success: false, taskId: 'T-001', turns: 1, committed: false, summary: '', logFile: '' }
    const success = { success: true, taskId: 'T-001', turns: 2, committed: true, summary: 'done', logFile: '' }

    const fn = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success)

    const result = await runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 10 })

    expect(result.success).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('returns failure result after exhausting retries on success=false', async () => {
    const failure = { success: false, taskId: 'T-001', turns: 1, committed: false, summary: '', logFile: '' }
    const fn = vi.fn().mockResolvedValue(failure)

    const result = await runWithFakeTimers(fn, { maxRetries: 2, baseDelayMs: 10 })

    expect(result.success).toBe(false)
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('withRetry - exponential backoff delays', () => {
  it('uses baseDelayMs * 2^(attempt-1) for each retry delay', async () => {
    const delays: number[] = []
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      onRetry: (_attempt, _err, delay) => { delays.push(delay) },
    })

    // Drive all delays
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
      vi.runAllTimers()
      await Promise.resolve()
    }

    await expect(promise).rejects.toThrow('fail')

    // attempt 1 → 100ms, attempt 2 → 200ms, attempt 3 → 400ms
    expect(delays).toEqual([100, 200, 400])
  })

  it('uses 1000ms base delay by default', async () => {
    const delays: number[] = []
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    const promise = withRetry(fn, {
      maxRetries: 1,
      onRetry: (_attempt, _err, delay) => { delays.push(delay) },
    })

    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
      vi.runAllTimers()
      await Promise.resolve()
    }

    await expect(promise).rejects.toThrow()
    expect(delays[0]).toBe(1000)
  })
})

describe('withRetry - non-retryable errors', () => {
  it('does not retry "No agent backend" error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('No agent backend available.'))

    await expect(
      runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('No agent backend')

    // Should only be called once (no retries)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry "Claude Code CLI not found" error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Claude Code CLI not found. Install the Claude Code VS Code extension.'))

    await expect(
      runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('Claude Code CLI not found')

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry "GitHub Copilot token not found" error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('GitHub Copilot token not found. Make sure you are signed in: gh auth login'))

    await expect(
      runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('GitHub Copilot token not found')

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry "token invalid or expired" error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('GitHub Copilot token invalid or expired. Run: gh auth refresh'))

    await expect(
      runWithFakeTimers(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('token invalid or expired')

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries generic/transient errors (not in non-retryable list)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network timeout'))

    await expect(
      runWithFakeTimers(fn, { maxRetries: 2, baseDelayMs: 10 })
    ).rejects.toThrow('network timeout')

    // Should retry: 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('withRetry - onRetry callback', () => {
  it('calls onRetry with correct attempt number', async () => {
    const attempts: number[] = []
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    await expect(
      runWithFakeTimers(fn, {
        maxRetries: 2,
        baseDelayMs: 10,
        onRetry: (attempt) => attempts.push(attempt),
      })
    ).rejects.toThrow()

    expect(attempts).toEqual([1, 2])
  })

  it('calls onRetry with the error that caused the retry', async () => {
    const errors: string[] = []
    const fn = vi.fn().mockRejectedValue(new Error('specific error message'))

    await expect(
      runWithFakeTimers(fn, {
        maxRetries: 1,
        baseDelayMs: 10,
        onRetry: (_attempt, err) => errors.push(err.message),
      })
    ).rejects.toThrow()

    expect(errors).toEqual(['specific error message'])
  })

  it('calls onRetry with the correct computed delay', async () => {
    const callbackDelays: number[] = []
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    await expect(
      runWithFakeTimers(fn, {
        maxRetries: 3,
        baseDelayMs: 50,
        onRetry: (_attempt, _err, delay) => callbackDelays.push(delay),
      })
    ).rejects.toThrow()

    // 50 * 2^0=50, 50 * 2^1=100, 50 * 2^2=200
    expect(callbackDelays).toEqual([50, 100, 200])
  })

  it('does not call onRetry on the final (last) attempt', async () => {
    const onRetry = vi.fn()
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    await expect(
      runWithFakeTimers(fn, { maxRetries: 2, baseDelayMs: 10, onRetry })
    ).rejects.toThrow()

    // maxRetries=2: called at attempt 1 and 2, NOT at the last throw
    expect(onRetry).toHaveBeenCalledTimes(2)
  })
})

describe('withRetry - default options', () => {
  it('defaults to maxRetries=3', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    const promise = withRetry(fn)
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
      vi.runAllTimers()
      await Promise.resolve()
    }

    await expect(promise).rejects.toThrow()
    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4)
  })
})
