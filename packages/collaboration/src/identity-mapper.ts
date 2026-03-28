import type { Contributor, Platform } from './types.js'
import { CollaborationStore } from './quorum-folder.js'

// ─── Identity Mapper ──────────────────────────────────────────────────────────
// Maps platform-specific user IDs to QUORUM user IDs and vice versa.
// This is how the approval manager knows "Teams user T123 = QUORUM user U456".
//
// Storage: .quorum/collaboration/contributors.json
// Each Contributor has: quorum_user_id, name, role, platforms: { teams: id, slack: id, ... }

// ─── Look up QUORUM user ID from a platform user ID ───────────────────────────

export async function resolveAtlasUserId(
  projectDir: string,
  platform: Platform,
  platformUserId: string
): Promise<string | null> {
  const store = new CollaborationStore(projectDir)
  const contributors = await store.getContributors()
  const match = contributors.find(c => c.platforms[platform] === platformUserId)
  return match?.quorum_user_id ?? null
}

// ─── Look up platform user ID from QUORUM user ID ─────────────────────────────

export async function resolvePlatformUserId(
  projectDir: string,
  quorumUserId: string,
  platform: Platform
): Promise<string | null> {
  const store = new CollaborationStore(projectDir)
  const contributors = await store.getContributors()
  const match = contributors.find(c => c.quorum_user_id === quorumUserId)
  return match?.platforms[platform] ?? null
}

// ─── Register a platform identity for an QUORUM user ──────────────────────────
// Called when a user taps "@QUORUM login" and completes OAuth.

export async function registerIdentity(
  projectDir: string,
  quorumUserId: string,
  name: string,
  platform: Platform,
  platformUserId: string,
  role: Contributor['role'] = 'member'
): Promise<Contributor> {
  const store = new CollaborationStore(projectDir)
  const existing = await store.getContributors()

  const found = existing.find(c => c.quorum_user_id === quorumUserId)
  const contributor: Contributor = found
    ? { ...found, name, role, platforms: { ...found.platforms, [platform]: platformUserId } }
    : {
        quorum_user_id: quorumUserId,
        name,
        role,
        platforms: { [platform]: platformUserId }
      }

  await store.upsertContributor(contributor)
  return contributor
}

// ─── Resolve a list of platform user IDs to QUORUM user IDs ───────────────────
// Used when building the required_approvers list for an approval request.
// Platform users with no QUORUM mapping are returned as-is (fallback).

export async function resolveApprovers(
  projectDir: string,
  platform: Platform,
  platformUserIds: string[]
): Promise<string[]> {
  const store = new CollaborationStore(projectDir)
  const contributors = await store.getContributors()

  return platformUserIds.map(platformId => {
    const match = contributors.find(c => c.platforms[platform] === platformId)
    return match?.quorum_user_id ?? platformId
  })
}

// ─── Get all contributors with a specific role ────────────────────────────────

export async function getContributorsByRole(
  projectDir: string,
  role: Contributor['role']
): Promise<Contributor[]> {
  const store = new CollaborationStore(projectDir)
  const contributors = await store.getContributors()
  return contributors.filter(c => c.role === role)
}

// ─── Get leads (first approvers in 'lead' quorum mode) ───────────────────────

export async function getLeadAtlasUserIds(projectDir: string): Promise<string[]> {
  const leads = await getContributorsByRole(projectDir, 'lead')
  return leads.map(l => l.quorum_user_id)
}

// ─── Infer required approvers from message mentions ──────────────────────────
// Looks for @name mentions in messages and matches them to known contributors.

export async function inferApproversFromMessages(
  projectDir: string,
  messages: Array<{ content: string; author_id: string }>,
  platform: Platform
): Promise<string[]> {
  const store = new CollaborationStore(projectDir)
  const contributors = await store.getContributors()

  const mentioned = new Set<string>()

  for (const msg of messages) {
    // Match @name or <@userId> style mentions
    const atMatches = msg.content.match(/@([\w.]+)/g) ?? []
    for (const mention of atMatches) {
      const name = mention.slice(1).toLowerCase()
      const match = contributors.find(c => c.name.toLowerCase().replace(/\s+/g, '.') === name ||
                                           c.name.toLowerCase() === name)
      if (match) mentioned.add(match.quorum_user_id)
    }
  }

  return Array.from(mentioned)
}

// ─── Format contributor display name ─────────────────────────────────────────

export async function getDisplayName(
  projectDir: string,
  quorumUserId: string
): Promise<string> {
  const store = new CollaborationStore(projectDir)
  const contributors = await store.getContributors()
  const match = contributors.find(c => c.quorum_user_id === quorumUserId)
  return match?.name ?? quorumUserId
}
