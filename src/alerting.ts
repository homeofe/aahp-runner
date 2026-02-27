import type { AlertConfig, AlertEvent } from './scheduler.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AlertPayload {
  event: AlertEvent
  repo?: string
  taskId?: string
  success?: boolean
  duration?: string      // human-readable duration
  summary?: string
  timestamp: string
  totalDone?: number
  totalFailed?: number
}

// ── Sender functions ─────────────────────────────────────────────────────────

async function sendWebhook(url: string, payload: AlertPayload): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.warn(`Alert webhook failed: ${String(err)}`)
  }
}

async function sendSlack(webhookUrl: string, payload: AlertPayload): Promise<void> {
  // Format as Slack Block Kit message
  let text: string
  let emoji: string

  switch (payload.event) {
    case 'agent_failed':
      emoji = ':x:'
      text = `*Agent failed* - ${payload.repo ?? 'unknown'} [${payload.taskId ?? '?'}]`
      if (payload.summary) text += `\n>${payload.summary.slice(0, 200)}`
      break
    case 'run_complete':
      emoji = payload.success ? ':white_check_mark:' : ':warning:'
      text = `*Run complete* - ${payload.repo ?? 'unknown'} [${payload.taskId ?? '?'}]`
      if (payload.duration) text += ` (${payload.duration})`
      break
    case 'all_done':
      emoji = ':tada:'
      text = `*All agents finished* - ${payload.totalDone ?? 0} done, ${payload.totalFailed ?? 0} failed`
      break
    default:
      emoji = ':robot_face:'
      text = `AAHP event: ${payload.event}`
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `${emoji} ${text}` },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `_${payload.timestamp}_` }],
          },
        ],
      }),
    })
  } catch (err) {
    console.warn(`Slack alert failed: ${String(err)}`)
  }
}

// ── Main alert dispatcher ────────────────────────────────────────────────────

/**
 * Send an alert if the event matches the configured alert events.
 * Fire-and-forget - never throws, never blocks.
 */
export async function sendAlert(
  config: AlertConfig | undefined,
  event: AlertEvent,
  payload: Omit<AlertPayload, 'event' | 'timestamp'>
): Promise<void> {
  if (!config) return

  // Check if this event type is enabled (default: all events)
  const enabledEvents = config.events ?? ['run_complete', 'agent_failed', 'all_done']
  if (!enabledEvents.includes(event)) return

  const fullPayload: AlertPayload = {
    ...payload,
    event,
    timestamp: new Date().toISOString(),
  }

  const promises: Promise<void>[] = []

  if (config.webhook) {
    promises.push(sendWebhook(config.webhook, fullPayload))
  }
  if (config.slack) {
    promises.push(sendSlack(config.slack, fullPayload))
  }

  // Fire-and-forget - don't await in production, but we do await here
  // so errors are caught and warned about
  await Promise.allSettled(promises)
}
