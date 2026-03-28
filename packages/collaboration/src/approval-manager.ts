import type { ApprovalRequest, ApprovalQuorum, PlanRequest } from './types.js'

// ─── Approval Manager ─────────────────────────────────────────────────────────
// Pure logic — no DB, no platform code.
// The caller (quorum-server) owns persistence and platform messaging.

export function createApprovalRequest(
  planRequestId: string,
  requiredApprovers: string[],
  quorum: ApprovalQuorum = 'any',
  timeoutHours = 24
): ApprovalRequest {
  const expiresAt = new Date(Date.now() + timeoutHours * 60 * 60 * 1000).toISOString()
  return {
    plan_request_id: planRequestId,
    required_approvers: requiredApprovers,
    approved_by: [],
    rejected_by: [],
    quorum,
    expires_at: expiresAt,
    status: 'pending'
  }
}

export function recordApproval(
  approval: ApprovalRequest,
  userId: string
): ApprovalRequest {
  if (approval.status !== 'pending') return approval
  if (approval.approved_by.includes(userId)) return approval  // idempotent

  const updated: ApprovalRequest = {
    ...approval,
    approved_by: [...approval.approved_by, userId]
  }

  if (isQuorumMet(updated)) {
    return { ...updated, status: 'approved' }
  }

  return updated
}

export function recordRejection(
  approval: ApprovalRequest,
  userId: string,
  reason?: string
): ApprovalRequest {
  if (approval.status !== 'pending') return approval
  return {
    ...approval,
    rejected_by: [...approval.rejected_by, userId],
    rejection_reason: reason,
    status: 'rejected'
  }
}

export function checkExpiry(approval: ApprovalRequest): ApprovalRequest {
  if (approval.status !== 'pending') return approval
  if (new Date() > new Date(approval.expires_at)) {
    return { ...approval, status: 'expired' }
  }
  return approval
}

function isQuorumMet(approval: ApprovalRequest): boolean {
  const { quorum, required_approvers, approved_by } = approval

  switch (quorum) {
    case 'any':
      return approved_by.length >= 1

    case 'all':
      return required_approvers.every(id => approved_by.includes(id))

    case 'majority': {
      const needed = Math.ceil(required_approvers.length / 2)
      return approved_by.filter(id => required_approvers.includes(id)).length >= needed
    }

    case 'lead':
      // Lead is the first person in required_approvers
      return required_approvers.length > 0 && approved_by.includes(required_approvers[0]!)
  }
}

// ─── Format approval summary for display ─────────────────────────────────────

export function formatApprovalStatus(approval: ApprovalRequest): string {
  const total = approval.required_approvers.length || 1
  const done = approval.approved_by.length
  const pct = Math.round((done / total) * 100)

  switch (approval.status) {
    case 'approved': return `✅ Approved (${done}/${total})`
    case 'rejected': return `❌ Rejected — ${approval.rejection_reason ?? 'no reason given'}`
    case 'expired':  return `⏰ Expired`
    case 'pending':  return `⏳ Waiting (${done}/${total} — ${pct}%)`
  }
}

// ─── Determine who still needs to approve ────────────────────────────────────

export function pendingApprovers(approval: ApprovalRequest): string[] {
  return approval.required_approvers.filter(id => !approval.approved_by.includes(id))
}

// ─── Check if a plan request is ready to execute ─────────────────────────────

export function isReadyToExecute(plan: PlanRequest, approval: ApprovalRequest): boolean {
  return plan.status === 'approved' && approval.status === 'approved'
}
