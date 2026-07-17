import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agentChannels, agents, channelEvents, channelSessions, conversations } from '../db/schema'
import { decryptSecret, encryptSecret, encryptionEnabled } from '../lib/crypto'
import { env } from '../env'
import {
  deleteTelegramWebhook,
  getTelegramBot,
  renderTelegramMarkdown,
  sendTelegramMessage,
  startTelegramTyping,
  telegramUpdateSchema,
  type TelegramUpdate,
} from '../lib/telegram'
import { prepareChatTurn, runPrepared } from './chat'
import { resolvePlatformUser } from './users'

export class ChannelError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

export type PublicChannel = {
  id: string
  agentId: string
  provider: string
  displayName: string
  externalUsername: string | null
  status: string
  lastError: string | null
  lastReceivedAt: Date | null
  createdAt: Date
}

const publicSelection = {
  id: agentChannels.id,
  agentId: agentChannels.agentId,
  provider: agentChannels.provider,
  displayName: agentChannels.displayName,
  externalUsername: agentChannels.externalUsername,
  status: agentChannels.status,
  lastError: agentChannels.lastError,
  lastReceivedAt: agentChannels.lastReceivedAt,
  createdAt: agentChannels.createdAt,
}

export async function listChannels(orgId: string, agentId?: string): Promise<PublicChannel[]> {
  return db
    .select(publicSelection)
    .from(agentChannels)
    .where(agentId ? and(eq(agentChannels.orgId, orgId), eq(agentChannels.agentId, agentId)) : eq(agentChannels.orgId, orgId))
    .orderBy(agentChannels.createdAt)
}

export async function connectTelegramChannel(input: {
  orgId: string
  agentId: string
  token: string
}): Promise<PublicChannel> {
  const token = input.token.trim()
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ChannelError('Enter only the raw Telegram bot token from BotFather')
  }

  const [existing] = await db
    .select({ id: agentChannels.id })
    .from(agentChannels)
    .where(and(eq(agentChannels.agentId, input.agentId), eq(agentChannels.provider, 'telegram')))
    .limit(1)
  if (existing) throw new ChannelError('This agent already has a Telegram bot. Disconnect it before adding another.', 409)

  let bot
  try {
    bot = await getTelegramBot(token)
  } catch {
    throw new ChannelError('Telegram rejected this bot token. Copy only the raw token from BotFather.')
  }
  const channelId = randomUUID()
  const credentialEncrypted = encryptionEnabled()

  try {
    await db.insert(agentChannels).values({
      id: channelId,
      orgId: input.orgId,
      agentId: input.agentId,
      provider: 'telegram',
      displayName: bot.first_name,
      externalId: String(bot.id),
      externalUsername: bot.username ?? null,
      credential: encryptSecret(token),
      credentialEncrypted,
      status: 'connecting',
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ChannelError('This Telegram bot is already connected to a Riwaq agent', 409)
    }
    throw error
  }

  try {
    // getUpdates and webhooks are mutually exclusive. Clear a webhook left by
    // an older Riwaq release before the local polling supervisor claims the bot.
    await deleteTelegramWebhook(token)
  } catch (error) {
    await db.delete(agentChannels).where(eq(agentChannels.id, channelId)).catch(() => {})
    throw new ChannelError(error instanceof Error ? error.message : 'Telegram polling setup failed', 502)
  }

  const [connected] = await db
    .update(agentChannels)
    .set({ status: 'active', lastError: null, updatedAt: new Date() })
    .where(eq(agentChannels.id, channelId))
    .returning(publicSelection)
  // A running server can pick up the new channel immediately. The dynamic
  // import avoids a channels ↔ polling module initialization cycle.
  void import('./telegram-polling').then(({ reconcileTelegramPollers }) => reconcileTelegramPollers()).catch(() => {})
  return connected!
}

export async function disconnectChannel(input: { orgId: string; agentId: string; channelId: string }) {
  const [channel] = await db
    .select()
    .from(agentChannels)
    .where(and(
      eq(agentChannels.id, input.channelId),
      eq(agentChannels.orgId, input.orgId),
      eq(agentChannels.agentId, input.agentId),
    ))
    .limit(1)
  if (!channel) throw new ChannelError('Channel not found', 404)

  if (channel.provider === 'telegram') {
    await import('./telegram-polling')
      .then(({ stopTelegramChannelPolling }) => stopTelegramChannelPolling(channel.id))
      .catch(() => {})
  }
  await db.delete(agentChannels).where(eq(agentChannels.id, channel.id))
  void import('./telegram-polling').then(({ reconcileTelegramPollers }) => reconcileTelegramPollers()).catch(() => {})
  return { ok: true as const }
}

/** Idempotently persist an update fetched by the trusted polling supervisor. */
export async function recordTelegramUpdate(
  channelId: string,
  body: unknown,
): Promise<{ eventId: string; shouldEnqueue: boolean }> {
  const [channel] = await db
    .select({ id: agentChannels.id })
    .from(agentChannels)
    .where(and(eq(agentChannels.id, channelId), eq(agentChannels.provider, 'telegram'), eq(agentChannels.status, 'active')))
    .limit(1)
  if (!channel) throw new ChannelError('Telegram channel not found', 404)

  const parsed = telegramUpdateSchema.safeParse(body)
  if (!parsed.success) throw new ChannelError('Invalid Telegram update')
  const [event] = await db
    .insert(channelEvents)
    .values({ channelId, providerEventId: String(parsed.data.update_id), payload: parsed.data })
    .onConflictDoNothing({ target: [channelEvents.channelId, channelEvents.providerEventId] })
    .returning({ id: channelEvents.id })

  await db
    .update(agentChannels)
    .set({ lastReceivedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentChannels.id, channelId))
  if (event) return { eventId: event.id, shouldEnqueue: true }

  // If queueing failed after the first insert, a repeated poll must recover the
  // existing pending/error event instead of acknowledging it without a job.
  const [existing] = await db
    .select({ id: channelEvents.id, status: channelEvents.status })
    .from(channelEvents)
    .where(and(eq(channelEvents.channelId, channelId), eq(channelEvents.providerEventId, String(parsed.data.update_id))))
    .limit(1)
  if (!existing) throw new Error('channel event disappeared after conflict')
  return { eventId: existing.id, shouldEnqueue: existing.status === 'pending' || existing.status === 'error' }
}

export async function conversationForChannel(input: {
  channelId: string
  agentId: string
  externalChatId: string
  externalUserId: string
  endUserId: string
}): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const idleCutoff = now.getTime() - env.CHANNEL_SESSION_IDLE_MINUTES * 60_000
    const [existing] = await tx
      .select({
        id: channelSessions.id,
        conversationId: channelSessions.conversationId,
        turnCount: channelSessions.turnCount,
        updatedAt: channelSessions.updatedAt,
      })
      .from(channelSessions)
      .where(and(
        eq(channelSessions.channelId, input.channelId),
        eq(channelSessions.externalChatId, input.externalChatId),
        eq(channelSessions.externalUserId, input.externalUserId),
      ))
      .limit(1)
      .for('update')
    if (existing) {
      const rotate = existing.turnCount >= env.CHANNEL_SESSION_MAX_TURNS
        || existing.updatedAt.getTime() <= idleCutoff
      if (!rotate) {
        await tx
          .update(channelSessions)
          .set({ turnCount: existing.turnCount + 1, updatedAt: now })
          .where(eq(channelSessions.id, existing.id))
        return existing.conversationId
      }

      const [conversation] = await tx
        .insert(conversations)
        .values({ agentId: input.agentId, endUserId: input.endUserId })
        .returning({ id: conversations.id })
      await tx
        .update(channelSessions)
        .set({ conversationId: conversation!.id, turnCount: 1, updatedAt: now })
        .where(eq(channelSessions.id, existing.id))
      return conversation!.id
    }

    const [conversation] = await tx
      .insert(conversations)
      .values({ agentId: input.agentId, endUserId: input.endUserId })
      .returning({ id: conversations.id })
    const inserted = await tx
      .insert(channelSessions)
      .values({
        channelId: input.channelId,
        externalChatId: input.externalChatId,
        externalUserId: input.externalUserId,
        conversationId: conversation!.id,
        turnCount: 1,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [channelSessions.channelId, channelSessions.externalChatId, channelSessions.externalUserId] })
      .returning({ conversationId: channelSessions.conversationId })
    if (inserted[0]) return inserted[0].conversationId

    const [winner] = await tx
      .select({ id: channelSessions.id, conversationId: channelSessions.conversationId, turnCount: channelSessions.turnCount })
      .from(channelSessions)
      .where(and(
        eq(channelSessions.channelId, input.channelId),
        eq(channelSessions.externalChatId, input.externalChatId),
        eq(channelSessions.externalUserId, input.externalUserId),
      ))
      .limit(1)
      .for('update')
    await tx.delete(conversations).where(eq(conversations.id, conversation!.id))
    if (!winner) throw new Error('failed to establish channel conversation')
    await tx
      .update(channelSessions)
      .set({ turnCount: winner.turnCount + 1, updatedAt: now })
      .where(eq(channelSessions.id, winner.id))
    return winner.conversationId
  })
}

async function resetChannelConversation(channelId: string, externalChatId: string, externalUserId: string) {
  await db.delete(channelSessions).where(and(
    eq(channelSessions.channelId, channelId),
    eq(channelSessions.externalChatId, externalChatId),
    eq(channelSessions.externalUserId, externalUserId),
  ))
}

function command(text: string): 'start' | 'help' | 'new' | null {
  const match = text.match(/^\/(start|help|new)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i)
  return (match?.[1]?.toLowerCase() as 'start' | 'help' | 'new' | undefined) ?? null
}

function telegramIdentity(update: TelegramUpdate) {
  const message = update.message
  if (!message?.from || message.from.is_bot) return null
  return {
    message,
    externalChatId: String(message.chat.id),
    externalUserId: String(message.from.id),
    fallbackEndUserId: `telegram:${message.from.id}`,
    displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') || message.from.username || null,
  }
}

export async function processChannelEvent(eventId: string): Promise<void> {
  const [row] = await db
    .select({ event: channelEvents, channel: agentChannels, agent: agents })
    .from(channelEvents)
    .innerJoin(agentChannels, eq(agentChannels.id, channelEvents.channelId))
    .innerJoin(agents, eq(agents.id, agentChannels.agentId))
    .where(eq(channelEvents.id, eventId))
    .limit(1)
  if (!row || row.event.status === 'processed') return
  if (row.channel.provider !== 'telegram') throw new Error(`unsupported channel provider: ${row.channel.provider}`)

  const token = decryptSecret(row.channel.credential, row.channel.credentialEncrypted)
  try {
    await db.update(channelEvents).set({ status: 'processing', lastError: null }).where(eq(channelEvents.id, eventId))
    const update = telegramUpdateSchema.parse(row.event.payload)
    const identity = telegramIdentity(update)
    if (!identity) {
      await markEventProcessed(eventId, row.channel.id)
      return
    }

    const { message, externalChatId, externalUserId, fallbackEndUserId, displayName } = identity
    const endUserId = await resolvePlatformUser({
      orgId: row.agent.orgId,
      provider: 'telegram',
      externalUserId,
      fallbackUserId: fallbackEndUserId,
      displayName,
    })
    let responseText = row.event.responseText
    if (!responseText) {
      const currentCommand = message.text ? command(message.text) : null
      if (currentCommand === 'start' || currentCommand === 'help') {
        responseText = `Hi! I’m ${row.agent.name}, powered by Riwaq. Send me a message and I’ll answer using my connected knowledge. Use /new to start a fresh conversation.`
      } else if (currentCommand === 'new') {
        await resetChannelConversation(row.channel.id, externalChatId, externalUserId)
        responseText = 'Started a new conversation. What would you like to know?'
      } else if (!message.text) {
        responseText = 'I can currently respond to text messages. Support for more message types is coming later.'
      } else {
        const typing = startTelegramTyping(token, {
          chatId: externalChatId,
          messageThreadId: message.message_thread_id,
        })
        try {
          const conversationId = await conversationForChannel({
            channelId: row.channel.id,
            agentId: row.agent.id,
            externalChatId,
            externalUserId,
            endUserId,
          })
          const prepared = await prepareChatTurn({
            agent: row.agent,
            endUserId,
            message: message.text,
            conversationId,
          })
          responseText = (await runPrepared(prepared)).answer
        } finally {
          await typing.stop()
        }
      }
      await db
        .update(channelEvents)
        .set({ responseText, status: 'responding' })
        .where(eq(channelEvents.id, eventId))
    }

    const [fresh] = await db
      .select({ sentPartCount: channelEvents.sentPartCount })
      .from(channelEvents)
      .where(eq(channelEvents.id, eventId))
      .limit(1)
    const parts = renderTelegramMarkdown(responseText)
    for (let index = fresh?.sentPartCount ?? 0; index < parts.length; index += 1) {
      await sendTelegramMessage(token, {
        chatId: externalChatId,
        text: parts[index]!.html,
        parseMode: 'HTML',
        fallbackText: parts[index]!.plainText,
        messageThreadId: message.message_thread_id,
      })
      await db.update(channelEvents).set({ sentPartCount: index + 1 }).where(eq(channelEvents.id, eventId))
    }
    await markEventProcessed(eventId, row.channel.id)
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Channel event failed'
    await Promise.all([
      db.update(channelEvents).set({ status: 'error', lastError: message }).where(eq(channelEvents.id, eventId)),
      db.update(agentChannels).set({ status: 'active', lastError: message, updatedAt: new Date() }).where(eq(agentChannels.id, row.channel.id)),
    ]).catch(() => {})
    throw error
  }
}

async function markEventProcessed(eventId: string, channelId: string) {
  await Promise.all([
    db.update(channelEvents).set({ status: 'processed', processedAt: new Date(), lastError: null }).where(eq(channelEvents.id, eventId)),
    db.update(agentChannels).set({ status: 'active', lastError: null, updatedAt: new Date() }).where(eq(agentChannels.id, channelId)),
  ])
}
