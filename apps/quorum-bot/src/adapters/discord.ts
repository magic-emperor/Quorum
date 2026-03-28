import { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, type Message, type Interaction, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js'
import type { BotMessage, BotContext, SentMessage, AdapterConfig } from '../types.js'
import { renderCard, type PlatformCard } from '../cards/card-builder.js'
import { handlePlan, handleStory, handleHelp, handleStatus, handleApprove, handleReject, handleLogout, handleCompact, getQuorumToken } from '../handlers/commands.js'

// ─── Discord Adapter ──────────────────────────────────────────────────────────
// Uses discord.js. Bot responds to @QUORUM mentions and slash commands.
// Button interactions are handled via the interactionCreate event.

const channelHistory = new Map<string, BotMessage[]>()
const MAX_HISTORY = 50

function recordMessage(channelId: string, msg: BotMessage): void {
  const history = channelHistory.get(channelId) ?? []
  history.push(msg)
  if (history.length > MAX_HISTORY) history.shift()
  channelHistory.set(channelId, history)
}

export function createDiscordAdapter(_config: AdapterConfig): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ]
  })

  function makeContext(channelId: string, userId: string, userName: string, replyFn: (msg: unknown) => Promise<Message | null>): BotContext {
    return {
      platform: 'discord',
      channelId,
      userId,
      userName,
      async reply(text: string) { await replyFn({ content: text }) },
      async replyCard(card: PlatformCard): Promise<SentMessage> {
        const payload = renderCard(card, 'discord') as { embeds: unknown[]; components?: unknown[] }
        const sent = await replyFn(payload)
        return { id: sent?.id }
      },
      async updateCard(messageId: string, card: PlatformCard) {
        const ch = client.channels.cache.get(channelId)
        if (!ch?.isTextBased()) return
        const msg = await (ch as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(messageId).catch(() => null)
        if (!msg) return
        const payload = renderCard(card, 'discord') as { embeds: unknown[]; components?: unknown[] }
        await msg.edit(payload as Parameters<typeof msg.edit>[0])
      },
      getHistory: (limit = 30) => (channelHistory.get(channelId) ?? []).slice(-limit),
      recordMessage: (msg: BotMessage) => recordMessage(channelId, msg),
      replaceHistory: (messages: BotMessage[]) => channelHistory.set(channelId, messages)
    }
  }

  client.on('ready', () => {
    console.log(`QUORUM Discord Bot ready — logged in as ${client.user?.tag}`)
  })

  // Record messages + respond to @QUORUM mentions
  client.on('messageCreate', async (message: Message) => {
    console.log(`[discord] message from ${message.author.username}: ${message.content.slice(0, 80)}`)
    if (message.author.bot) return

    // Record to history
    recordMessage(message.channelId, {
      id: message.id,
      text: message.content,
      author: message.author.displayName ?? message.author.username,
      authorId: message.author.id,
      channelId: message.channelId,
      platform: 'discord',
      timestamp: message.createdAt.toISOString(),
      isBot: message.author.bot
    })

    // Respond to proper @mention OR text starting with @atlas / !atlas
    const isMention = message.mentions.has(client.user!)
    const isTextCommand = /^(@atlas|!atlas)\b/i.test(message.content.trim())
    if (!isMention && !isTextCommand) return

    const text = message.content.replace(/<@[^>]+>/g, '').replace(/^(@atlas|!atlas)\s*/i, '').trim()
    const lower = text.toLowerCase()

    const quorumToken = await getQuorumToken('discord', message.author.id)
    const replyFn = async (msg: unknown) => message.reply(msg as Parameters<typeof message.reply>[0]).catch(() => null)
    const ctx = makeContext(message.channelId, message.author.id, message.author.displayName, replyFn)

    if (!quorumToken && !lower.includes('help') && !lower.includes('login')) {
      const serverUrl = process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001'
      await ctx.reply(`🔐 Link your QUORUM account: ${serverUrl}/api/auth/discord/link?discord_user_id=${encodeURIComponent(message.author.id)}`)
      return
    }

    try {
      if (lower.includes('plan')) {
        await handlePlan(ctx, quorumToken!)
      } else if (lower.includes('story')) {
        const hint = text.replace(/story\s*/i, '').trim() || undefined
        await handleStory(ctx, quorumToken!, hint)
      } else if (lower.includes('status')) {
        await handleStatus(ctx, quorumToken)
      } else if (lower.includes('help')) {
        await handleHelp(ctx)
      } else if (lower.includes('compact')) {
        await handleCompact(ctx)
      } else if (lower.includes('logout')) {
        await handleLogout(ctx, message.author.id)
      } else if (lower.includes('login')) {
        const serverUrl = process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001'
        await ctx.reply(`🔐 Link your account: ${serverUrl}/api/auth/discord/link?discord_user_id=${encodeURIComponent(message.author.id)}`)
      } else {
        await ctx.reply('Unknown command. Try `!atlas help`')
      }
    } catch (err) {
      console.error('[discord] command error:', err)
      await ctx.reply(`❌ Error: ${(err as Error).message}`).catch(() => {})
    }
  })

  // Handle button interactions and modal submissions
  client.on('interactionCreate', async (interaction: Interaction) => {

    // ── Button click ──────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const btn = interaction as ButtonInteraction
      const parts = btn.customId.split(':')
      const action = parts[0]
      const planId = parts[1]
      const projectDir = parts.slice(2).join(':')

      if (!action || !planId || !projectDir) return

      const quorumToken = await getQuorumToken('discord', btn.user.id)

      if (!quorumToken) {
        await btn.reply({ content: '🔐 Link your QUORUM account first: `!atlas login`', ephemeral: true })
        return
      }

      if (action === 'reject_reason') {
        // Show a modal to collect the rejection reason
        const modal = new ModalBuilder()
          .setCustomId(`reject_modal:${planId}:${projectDir}`)
          .setTitle('Reject Plan')

        const reasonInput = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why are you rejecting this plan?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput))
        await btn.showModal(modal)
        return
      }

      await btn.deferUpdate()

      const ctx = makeContext(
        btn.channelId ?? '',
        btn.user.id,
        btn.user.displayName ?? btn.user.username,
        async (msg: unknown) => btn.followUp(msg as Parameters<typeof btn.followUp>[0]).then(() => null)
      )

      if (action === 'approve') {
        await handleApprove(ctx, quorumToken, planId, projectDir, btn.message.id)
      } else if (action === 'reject') {
        await handleReject(ctx, quorumToken, planId, projectDir, undefined, btn.message.id)
      }
    }

    // ── Modal submit ──────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const modal = interaction as ModalSubmitInteraction
      if (!modal.customId.startsWith('reject_modal:')) return

      const parts = modal.customId.split(':')
      const planId = parts[1]
      const projectDir = parts.slice(2).join(':')
      const reason = modal.fields.getTextInputValue('reason')

      await modal.deferUpdate()

      const quorumToken = await getQuorumToken('discord', modal.user.id)
      if (!quorumToken) {
        await modal.followUp({ content: '🔐 Link your QUORUM account first.', ephemeral: true })
        return
      }

      const ctx = makeContext(
        modal.channelId ?? '',
        modal.user.id,
        modal.user.displayName ?? modal.user.username,
        async (msg: unknown) => modal.followUp(msg as Parameters<typeof modal.followUp>[0]).then(() => null)
      )

      await handleReject(ctx, quorumToken, planId, projectDir, reason)
    }
  })

  return client
}
