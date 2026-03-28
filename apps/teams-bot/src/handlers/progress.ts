import { io as SocketClient, type Socket } from 'socket.io-client'
import type { CardFactory, TurnContext } from 'botbuilder'
import { buildProgressCard } from '../cards/approval-card.js'

// ─── Progress Streaming ───────────────────────────────────────────────────────
// After a plan is approved and execution starts, the bot connects to quorum-server
// via Socket.IO and relays session:event updates as progress card updates in Teams.
//
// Flow:
//   1. approvePlan() returns { session_id }
//   2. Bot calls subscribeToProgress(sessionId, quorumToken, ctx)
//   3. Socket.IO client joins session room, listens for session:event
//   4. Each progress event → updateActivity() on the approval card

const SERVER_URL = (process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')

// Active socket subscriptions: sessionId → Socket
const activeSubscriptions = new Map<string, Socket>()

export interface ProgressSubscription {
  sessionId: string
  unsubscribe: () => void
}

/**
 * Subscribe to a session's progress events and stream them back to a Teams channel.
 *
 * @param sessionId  - Atlas session ID from /api/sessions
 * @param quorumToken - User's JWT token (used for Socket.IO auth)
 * @param sendUpdate - Callback to post/update a message in Teams
 */
export function subscribeToProgress(
  sessionId: string,
  quorumToken: string,
  sendUpdate: (status: string, message: string, isDone: boolean) => Promise<void>
): ProgressSubscription {
  // Don't double-subscribe
  if (activeSubscriptions.has(sessionId)) {
    const existing = activeSubscriptions.get(sessionId)!
    return { sessionId, unsubscribe: () => existing.disconnect() }
  }

  const socket = SocketClient(SERVER_URL, {
    auth: { token: quorumToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 2000
  })

  activeSubscriptions.set(sessionId, socket)

  socket.on('connect', () => {
    socket.emit('session:join', sessionId)
  })

  socket.on('session:event', (event: { session_id: string; event_type: string; payload: unknown }) => {
    if (event.session_id !== sessionId) return

    const payload = event.payload as Record<string, unknown>

    switch (event.event_type) {
      case 'progress': {
        const msg = String(payload['message'] ?? '')
        if (msg.trim()) {
          sendUpdate('default', msg, false).catch(console.error)
        }
        break
      }

      case 'session:started':
        sendUpdate('good', '▶️ Execution started...', false).catch(console.error)
        break

      case 'session:end': {
        const status = String(payload['status'] ?? 'unknown')
        if (status === 'completed') {
          sendUpdate('good', '✅ Execution complete.', true).catch(console.error)
        } else if (status === 'failed' || status === 'error') {
          const errMsg = payload['error'] ? ` — ${payload['error']}` : ''
          sendUpdate('attention', `❌ Execution failed${errMsg}`, true).catch(console.error)
        } else if (status === 'interrupted') {
          sendUpdate('attention', '⏹️ Session interrupted.', true).catch(console.error)
        }

        // Clean up subscription when session ends
        socket.disconnect()
        activeSubscriptions.delete(sessionId)
        break
      }
    }
  })

  socket.on('connect_error', (err: Error) => {
    console.error(`[progress] Socket connect error for session ${sessionId}:`, err.message)
  })

  socket.on('disconnect', () => {
    activeSubscriptions.delete(sessionId)
  })

  return {
    sessionId,
    unsubscribe: () => {
      socket.disconnect()
      activeSubscriptions.delete(sessionId)
    }
  }
}

/**
 * Higher-level helper used by bot.ts after plan approval.
 * Subscribes to the session and sends incremental progress messages
 * to the Teams channel as plain text (progress cards are optional).
 */
export async function streamProgressToChannel(
  sessionId: string,
  quorumToken: string,
  ctx: TurnContext,
  cardFactory: typeof CardFactory
): Promise<ProgressSubscription> {
  let progressText: string[] = []
  let lastActivityId: string | undefined

  const sendUpdate = async (status: string, message: string, isDone: boolean) => {
    progressText.push(message)

    // Keep last 10 lines for the card body
    const displayLines = progressText.slice(-10)

    const card = buildProgressCard({
      sessionId,
      lines: displayLines,
      status: isDone
        ? (status === 'good' ? 'completed' : 'failed')
        : 'running'
    })

    try {
      if (lastActivityId) {
        await ctx.updateActivity({
          id: lastActivityId,
          type: 'message',
          attachments: [cardFactory.adaptiveCard(card)]
        })
      } else {
        const sent = await ctx.sendActivity({
          attachments: [cardFactory.adaptiveCard(card)]
        })
        lastActivityId = sent?.id
      }
    } catch {
      // Card update can fail if activity was deleted — fall back to new message
      const sent = await ctx.sendActivity({
        attachments: [cardFactory.adaptiveCard(card)]
      })
      lastActivityId = sent?.id
    }
  }

  return subscribeToProgress(sessionId, quorumToken, sendUpdate)
}

export function isSubscribed(sessionId: string): boolean {
  return activeSubscriptions.has(sessionId)
}

export function unsubscribeAll(): void {
  for (const socket of activeSubscriptions.values()) {
    socket.disconnect()
  }
  activeSubscriptions.clear()
}
