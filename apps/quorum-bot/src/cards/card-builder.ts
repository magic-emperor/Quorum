import type { PlatformCard, Platform } from '../types.js'

// ─── Platform-agnostic card builder ──────────────────────────────────────────
// Produces a PlatformCard descriptor. Each adapter translates this to its
// native format: Adaptive Card (Teams), Block Kit (Slack), Embeds (Discord),
// InlineKeyboard (Telegram).

export interface ApprovalCardData {
  planId: string
  projectDir: string
  summary: string
  decisions: string[]
  acceptanceCriteria: string[]
  requesterName: string
  expiresAt: string
}

export interface ProgressCardData {
  sessionId: string
  lines: string[]
  status: 'running' | 'completed' | 'failed'
}

export function approvalCard(data: ApprovalCardData): PlatformCard {
  return { type: 'approval', data: data as unknown as Record<string, unknown> }
}

export function approvedCard(planId: string, approverName: string): PlatformCard {
  return { type: 'approved', data: { planId, approverName } }
}

export function rejectedCard(planId: string, rejectorName: string, reason?: string): PlatformCard {
  return { type: 'rejected', data: { planId, rejectorName, reason } }
}

export function progressCard(data: ProgressCardData): PlatformCard {
  return { type: 'progress', data: data as unknown as Record<string, unknown> }
}

// ─── Teams: Adaptive Card renderer ───────────────────────────────────────────

export function toTeamsAdaptiveCard(card: PlatformCard): Record<string, unknown> {
  if (card.type === 'approval') {
    const d = card.data as ApprovalCardData
    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body: [
        { type: 'TextBlock', text: '📋 QUORUM Plan Ready', weight: 'Bolder', size: 'Medium' },
        { type: 'TextBlock', text: d.summary, wrap: true },
        d.decisions.length > 0 && {
          type: 'TextBlock',
          text: d.decisions.map(x => `• ${x}`).join('\n'),
          wrap: true, spacing: 'Small'
        },
        { type: 'TextBlock', text: `Project: ${d.projectDir}`, isSubtle: true, size: 'Small' }
      ].filter(Boolean),
      actions: [
        { type: 'Action.Execute', title: '✅ Approve', verb: 'approve',
          data: { action: 'approve', plan_id: d.planId, project_dir: d.projectDir } },
        { type: 'Action.Execute', title: '❌ Reject', verb: 'reject',
          data: { action: 'reject', plan_id: d.planId, project_dir: d.projectDir } }
      ]
    }
  }

  if (card.type === 'approved') {
    const d = card.data as { planId: string; approverName: string }
    return {
      type: 'AdaptiveCard', version: '1.5',
      body: [{ type: 'TextBlock', text: `✅ Plan approved by ${d.approverName}. Executing...`, color: 'Good', weight: 'Bolder' }]
    }
  }

  if (card.type === 'rejected') {
    const d = card.data as { planId: string; rejectorName: string; reason?: string }
    return {
      type: 'AdaptiveCard', version: '1.5',
      body: [
        { type: 'TextBlock', text: `❌ Plan rejected by ${d.rejectorName}`, color: 'Attention', weight: 'Bolder' },
        d.reason && { type: 'TextBlock', text: `Reason: ${d.reason}`, wrap: true }
      ].filter(Boolean)
    }
  }

  if (card.type === 'progress') {
    const d = card.data as ProgressCardData
    const color = d.status === 'completed' ? 'Good' : d.status === 'failed' ? 'Attention' : 'Default'
    return {
      type: 'AdaptiveCard', version: '1.5',
      body: [
        { type: 'TextBlock', text: '⚙️ QUORUM Executing...', weight: 'Bolder' },
        { type: 'TextBlock', text: d.lines.join('\n'), wrap: true, fontType: 'Monospace', color }
      ]
    }
  }

  return { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Unknown card type' }] }
}

// ─── Slack: Block Kit renderer ────────────────────────────────────────────────

export function toSlackBlocks(card: PlatformCard): unknown[] {
  if (card.type === 'approval') {
    const d = card.data as ApprovalCardData
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*📋 QUORUM Plan Ready*\n${d.summary}` } },
      d.decisions.length > 0 && {
        type: 'section',
        text: { type: 'mrkdwn', text: d.decisions.map(x => `• ${x}`).join('\n') }
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Project: \`${d.projectDir}\`` }] },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ Approve' }, style: 'primary',
            action_id: 'approve_plan', value: JSON.stringify({ plan_id: d.planId, project_dir: d.projectDir }) },
          { type: 'button', text: { type: 'plain_text', text: '❌ Reject' }, style: 'danger',
            action_id: 'reject_plan', value: JSON.stringify({ plan_id: d.planId, project_dir: d.projectDir }) },
          { type: 'button', text: { type: 'plain_text', text: '💬 Reject with reason' },
            action_id: 'reject_reason_plan', value: JSON.stringify({ plan_id: d.planId, project_dir: d.projectDir }) }
        ]
      }
    ].filter(Boolean)
  }

  if (card.type === 'approved') {
    const d = card.data as { approverName: string }
    return [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *Plan approved by ${d.approverName}. Executing...*` } }]
  }

  if (card.type === 'rejected') {
    const d = card.data as { rejectorName: string; reason?: string }
    return [{ type: 'section', text: { type: 'mrkdwn', text: `❌ *Plan rejected by ${d.rejectorName}*${d.reason ? `\nReason: ${d.reason}` : ''}` } }]
  }

  if (card.type === 'progress') {
    const d = card.data as ProgressCardData
    const icon = d.status === 'completed' ? '✅' : d.status === 'failed' ? '❌' : '⚙️'
    return [{ type: 'section', text: { type: 'mrkdwn', text: `${icon} \`\`\`${d.lines.slice(-5).join('\n')}\`\`\`` } }]
  }

  return []
}

// ─── Discord: Embed renderer ──────────────────────────────────────────────────

export function toDiscordEmbed(card: PlatformCard): { embeds: unknown[]; components?: unknown[] } {
  if (card.type === 'approval') {
    const d = card.data as ApprovalCardData
    return {
      embeds: [{
        title: '📋 QUORUM Plan Ready',
        description: d.summary,
        color: 0x5865F2,
        fields: d.decisions.length > 0 ? [{ name: 'Decisions', value: d.decisions.map(x => `• ${x}`).join('\n') }] : [],
        footer: { text: `Project: ${d.projectDir}` }
      }],
      components: [{
        type: 1, // Action Row
        components: [
          { type: 2, style: 3, label: '✅ Approve',            custom_id: `approve:${d.planId}:${d.projectDir}` },
          { type: 2, style: 4, label: '❌ Reject',             custom_id: `reject:${d.planId}:${d.projectDir}` },
          { type: 2, style: 2, label: '💬 Reject with reason', custom_id: `reject_reason:${d.planId}:${d.projectDir}` }
        ]
      }]
    }
  }

  if (card.type === 'approved') {
    const d = card.data as { approverName: string }
    return { embeds: [{ description: `✅ Plan approved by **${d.approverName}**. Executing...`, color: 0x57F287 }] }
  }

  if (card.type === 'rejected') {
    const d = card.data as { rejectorName: string; reason?: string }
    return { embeds: [{ description: `❌ Plan rejected by **${d.rejectorName}**${d.reason ? `\nReason: ${d.reason}` : ''}`, color: 0xED4245 }] }
  }

  if (card.type === 'progress') {
    const d = card.data as ProgressCardData
    const color = d.status === 'completed' ? 0x57F287 : d.status === 'failed' ? 0xED4245 : 0xFEE75C
    return { embeds: [{ description: `\`\`\`\n${d.lines.slice(-5).join('\n')}\n\`\`\``, color }] }
  }

  return { embeds: [] }
}

// ─── Telegram: text + inline keyboard renderer ────────────────────────────────

export function toTelegramMessage(card: PlatformCard): { text: string; reply_markup?: unknown; parse_mode?: string } {
  if (card.type === 'approval') {
    const d = card.data as ApprovalCardData
    const decisionsText = d.decisions.length > 0
      ? `\n\n*Decisions:*\n${d.decisions.map(x => `• ${x}`).join('\n')}`
      : ''
    const criteriaText = d.acceptanceCriteria.length > 0
      ? `\n\n*Done when:*\n${d.acceptanceCriteria.map(x => `• ${x}`).join('\n')}`
      : ''
    return {
      text: `📋 *QUORUM Plan Ready*\n\n${d.summary}${decisionsText}${criteriaText}\n\n_Requested by ${d.requesterName} · Project: ${d.projectDir}_`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${d.planId}:${d.projectDir}` },
            { text: '❌ Reject',  callback_data: `reject:${d.planId}:${d.projectDir}` }
          ],
          [
            { text: '💬 Reject with reason', callback_data: `reject_reason:${d.planId}:${d.projectDir}` }
          ]
        ]
      }
    }
  }

  if (card.type === 'approved') {
    const d = card.data as { approverName: string }
    return { text: `✅ *Plan approved by ${d.approverName}\\. Executing\\.\\.\\.*`, parse_mode: 'MarkdownV2' }
  }

  if (card.type === 'rejected') {
    const d = card.data as { rejectorName: string; reason?: string }
    return { text: `❌ *Plan rejected by ${d.rejectorName}*${d.reason ? `\nReason: ${d.reason}` : ''}`, parse_mode: 'Markdown' }
  }

  if (card.type === 'progress') {
    const d = card.data as ProgressCardData
    const icon = d.status === 'completed' ? '✅' : d.status === 'failed' ? '❌' : '⚙️'
    return { text: `${icon}\n\`\`\`\n${d.lines.slice(-5).join('\n')}\n\`\`\``, parse_mode: 'Markdown' }
  }

  return { text: 'Unknown card type' }
}

/** Route a card to the right renderer for the given platform */
export function renderCard(card: PlatformCard, platform: Platform): unknown {
  switch (platform) {
    case 'teams':    return toTeamsAdaptiveCard(card)
    case 'slack':    return toSlackBlocks(card)
    case 'discord':  return toDiscordEmbed(card)
    case 'telegram': return toTelegramMessage(card)
  }
}
