import type { ConversationSummary } from '@quorum/collaboration'

// ─── Adaptive Card builders for Teams ────────────────────────────────────────
// These produce JSON that Teams renders natively as rich interactive cards.

interface ApprovalCardOptions {
  planId: string
  projectDir: string
  summary: ConversationSummary
  requesterName: string
  expiresAt: string
}

/** The main approval card — shows summary + Approve/Reject buttons */
export function buildApprovalCard(opts: ApprovalCardOptions): Record<string, unknown> {
  const { planId, projectDir, summary, requesterName, expiresAt } = opts

  const criteriaItems = summary.acceptance_criteria.map(ac => ({
    type: 'TextBlock',
    text: `• ${ac}`,
    wrap: true,
    size: 'Small',
    color: 'Default'
  }))

  const decisionsText = summary.decisions.length > 0
    ? summary.decisions.map(d => `• ${d}`).join('\n')
    : 'None recorded'

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      {
        type: 'Container',
        style: 'emphasis',
        items: [
          {
            type: 'ColumnSet',
            columns: [
              {
                type: 'Column',
                width: 'auto',
                items: [{
                  type: 'Image',
                  url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Robot/3D/robot_3d.png',
                  size: 'Small'
                }]
              },
              {
                type: 'Column',
                width: 'stretch',
                items: [
                  { type: 'TextBlock', text: 'QUORUM Plan Ready', weight: 'Bolder', size: 'Medium' },
                  { type: 'TextBlock', text: `Requested by ${requesterName}`, spacing: 'None', isSubtle: true, size: 'Small' }
                ]
              }
            ]
          }
        ]
      },
      {
        type: 'Container',
        items: [
          { type: 'TextBlock', text: '**Context**', weight: 'Bolder' },
          { type: 'TextBlock', text: summary.context, wrap: true }
        ],
        spacing: 'Medium'
      },
      {
        type: 'Container',
        items: [
          { type: 'TextBlock', text: '**Decisions**', weight: 'Bolder' },
          { type: 'TextBlock', text: decisionsText, wrap: true, size: 'Small' }
        ],
        spacing: 'Small'
      },
      ...(criteriaItems.length > 0 ? [{
        type: 'Container',
        items: [
          { type: 'TextBlock', text: '**Done when**', weight: 'Bolder' },
          ...criteriaItems
        ],
        spacing: 'Small'
      }] : []),
      {
        type: 'FactSet',
        facts: [
          { title: 'Project', value: projectDir.split('/').pop() ?? projectDir },
          { title: 'Plan ID', value: planId },
          { title: 'Expires', value: new Date(expiresAt).toLocaleString() }
        ],
        spacing: 'Medium'
      }
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '✅ Approve',
        style: 'positive',
        data: { plan_id: planId, project_dir: projectDir, action: 'approve' }
      },
      {
        type: 'Action.Submit',
        title: '❌ Reject',
        style: 'destructive',
        data: { plan_id: planId, project_dir: projectDir, action: 'reject' }
      },
      {
        type: 'Action.ShowCard',
        title: '💬 Reject with reason',
        card: {
          type: 'AdaptiveCard',
          body: [{
            type: 'Input.Text',
            id: 'rejection_reason',
            placeholder: 'Why are you rejecting this plan?',
            isMultiline: true
          }],
          actions: [{
            type: 'Action.Submit',
            title: 'Submit rejection',
            data: { plan_id: planId, project_dir: projectDir, action: 'reject' }
          }]
        }
      }
    ]
  }
}

/** Updated card shown after someone approves — shows progress */
export function buildApprovedCard(planId: string, approvedBy: string): Record<string, unknown> {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      {
        type: 'Container',
        style: 'good',
        items: [
          { type: 'TextBlock', text: '✅ Plan Approved — Executing', weight: 'Bolder', size: 'Medium', color: 'Good' },
          { type: 'TextBlock', text: `Approved by ${approvedBy}`, isSubtle: true, size: 'Small' },
          { type: 'TextBlock', text: `Plan ID: ${planId}`, isSubtle: true, size: 'Small' }
        ]
      },
      {
        type: 'TextBlock',
        text: 'QUORUM is building. Progress updates will appear here.',
        wrap: true,
        spacing: 'Medium'
      }
    ]
  }
}

/** Rejected card */
export function buildRejectedCard(planId: string, rejectedBy: string, reason?: string): Record<string, unknown> {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      {
        type: 'Container',
        style: 'attention',
        items: [
          { type: 'TextBlock', text: '❌ Plan Rejected', weight: 'Bolder', size: 'Medium', color: 'Attention' },
          { type: 'TextBlock', text: `Rejected by ${rejectedBy}`, isSubtle: true, size: 'Small' },
          ...(reason ? [{ type: 'TextBlock', text: `Reason: ${reason}`, wrap: true }] : [])
        ]
      },
      {
        type: 'TextBlock',
        text: 'Continue the discussion and call @QUORUM plan again when ready.',
        wrap: true,
        isSubtle: true,
        spacing: 'Medium'
      }
    ]
  }
}

/** Progress update card — replace previous card with live status */
export function buildProgressCard(opts: {
  sessionId: string
  lines: string[]
  status: 'running' | 'completed' | 'failed'
}): Record<string, unknown> {
  const { sessionId, lines, status } = opts
  const isError = status === 'failed'
  const isDone = status === 'completed'
  const icon = isDone ? '✅' : isError ? '❌' : '⚙️'
  const label = isDone ? 'Execution complete' : isError ? 'Execution failed' : 'Running…'

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      {
        type: 'Container',
        style: isError ? 'attention' : isDone ? 'good' : 'default',
        items: [
          {
            type: 'TextBlock',
            text: `${icon} ${label}`,
            weight: 'Bolder',
            size: 'Medium'
          },
          ...(lines.length > 0 ? [{
            type: 'TextBlock',
            text: lines.join('\n'),
            wrap: true,
            size: 'Small',
            isSubtle: true,
            fontType: 'Monospace'
          }] : []),
          { type: 'TextBlock', text: `Session: ${sessionId}`, size: 'Small', isSubtle: true }
        ]
      }
    ]
  }
}
