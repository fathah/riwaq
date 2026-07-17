import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agentChannels, agents, channelEvents, channelSessions, conversations } from '../db/schema'
import { decryptSecret, encryptSecret, encryptionEnabled } from '../lib/crypto'
import {
  deleteTelegramWebhook,
  getTelegramBot,
  sendTelegramMessage,
  sendTelegramTyping,
  setTelegramWebhook,
  splitTelegramText,
  telegramUpdateSchema,
  type TelegramUpdate,
} from '../lib/telegram'
import { env } from '../env'
import { prepareChatTurn, runPrepared } from './chat'

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

function hashWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url')
}

function matchesWebhookSecret(provided: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashWebhookSecret(provided))
  const expected = Buffer.from(expectedHash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function telegramWebhookUrl(channelId: string): string {
  const raw = env.RIWAQ_PUBLIC_API_URL.trim()
  if (!raw) throw new ChannelError('RIWAQ_PUBLIC_API_URL must be set before connecting Telegram')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ChannelError('RIWAQ_PUBLIC_API_URL must be a valid public HTTPS URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ChannelError('RIWAQ_PUBLIC_API_URL must be a public HTTPS URL without credentials, query, or fragment')
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/webhooks/telegram/${channelId}`
  return url.toString()
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

  const channelId = randomUUID()
  const webhookUrl = telegramWebhookUrl(channelId)
  let bot
  try {
    bot = await getTelegramBot(token)
  } catch {
    throw new ChannelError('Telegram rejected this bot token. Copy only the raw token from BotFather.')
  }
  const webhookSecret = randomBytes(32).toString('base64url')
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
      webhookSecretHash: hashWebhookSecret(webhookSecret),
      status: 'connecting',
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ChannelError('This Telegram bot is already connected to a Riwaq agent', 409)
    }
    throw error
  }

  try {
    await setTelegramWebhook(token, webhookUrl, webhookSecret)
  } catch (error) {
    await db.delete(agentChannels).where(eq(agentChannels.id, channelId)).catch(() => {})
    throw new ChannelError(error instanceof Error ? error.message : 'Telegram webhook registration failed', 502)
  }

  const [connected] = await db
    .update(agentChannels)
    .set({ status: 'active', lastError: null, updatedAt: new Date() })
    .where(eq(agentChannels.id, channelId))
    .returning(publicSelection)
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

  let webhookRemoved = true
  if (channel.provider === 'telegram') {
    try {
      await deleteTelegramWebhook(decryptSecret(channel.credential, channel.credentialEncrypted))
    } catch {
      // A revoked token must not trap an operator in a connection they cannot remove.
      webhookRemoved = false
    }
  }
  await db.delete(agentChannels).where(eq(agentChannels.id, channel.id))
  return { ok: true as const, webhookRemoved }
}

/** Validate and idempotently persist a Telegram webhook. The caller enqueues the
 * returned event ID and can acknowledge Telegram immediately. */
export async function acceptTelegramUpdate(
  channelId: string,
  secret: string,
  body: unknown,
): Promise<{ eventId: string; shouldEnqueue: boolean }> {
  const [channel] = await db
    .select({ id: agentChannels.id, secretHash: agentChannels.webhookSecretHash })
    .from(agentChannels)
    .where(and(eq(agentChannels.id, channelId), eq(agentChannels.provider, 'telegram'), eq(agentChannels.status, 'active')))
    .limit(1)
  if (!channel || !secret || !matchesWebhookSecret(secret, channel.secretHash)) {
    throw new ChannelError('Webhook not found', 404)
  }

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

  // If queueing failed after the first insert, Telegram's retry must recover the
  // existing pending/error event instead of acknowledging it without a job.
  const [existing] = await db
    .select({ id: channelEvents.id, status: channelEvents.status })
    .from(channelEvents)
    .where(and(eq(channelEvents.channelId, channelId), eq(channelEvents.providerEventId, String(parsed.data.update_id))))
    .limit(1)
  if (!existing) throw new Error('channel event disappeared after conflict')
  return { eventId: existing.id, shouldEnqueue: existing.status === 'pending' || existing.status === 'error' }
}

async function conversationForChannel(input: {
  channelId: string
  agentId: string
  externalChatId: string
  externalUserId: string
  endUserId: string
}): Promise<string> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ conversationId: channelSessions.conversationId })
      .from(channelSessions)
      .where(and(
        eq(channelSessions.channelId, input.channelId),
        eq(channelSessions.externalChatId, input.externalChatId),
        eq(channelSessions.externalUserId, input.externalUserId),
      ))
      .limit(1)
    if (existing) return existing.conversationId

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
      })
      .onConflictDoNothing({ target: [channelSessions.channelId, channelSessions.externalChatId, channelSessions.externalUserId] })
      .returning({ conversationId: channelSessions.conversationId })
    if (inserted[0]) return inserted[0].conversationId

    const [winner] = await tx
      .select({ conversationId: channelSessions.conversationId })
      .from(channelSessions)
      .where(and(
        eq(channelSessions.channelId, input.channelId),
        eq(channelSessions.externalChatId, input.externalChatId),
        eq(channelSessions.externalUserId, input.externalUserId),
      ))
      .limit(1)
    await tx.delete(conversations).where(eq(conversations.id, conversation!.id))
    if (!winner) throw new Error('failed to establish channel conversation')
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
    endUserId: `telegram:${message.from.id}`,
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

    const { message, externalChatId, externalUserId, endUserId } = identity
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
        await sendTelegramTyping(token, externalChatId, message.message_thread_id).catch(() => {})
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
    const parts = splitTelegramText(responseText)
    for (let index = fresh?.sentPartCount ?? 0; index < parts.length; index += 1) {
      await sendTelegramMessage(token, {
        chatId: externalChatId,
        text: parts[index]!,
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
