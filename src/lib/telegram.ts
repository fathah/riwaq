import { z } from 'zod'
import { env } from '../env'

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
})

export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z.object({
    message_id: z.number().int(),
    message_thread_id: z.number().int().optional(),
    text: z.string().max(4096).optional(),
    from: z.object({
      id: z.number().int(),
      is_bot: z.boolean().optional(),
      first_name: z.string().optional(),
      username: z.string().optional(),
    }).optional(),
    chat: z.object({
      id: z.number().int(),
      type: z.enum(['private', 'group', 'supergroup', 'channel']),
    }),
  }).optional(),
})

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>

const telegramBotSchema = z.object({
  id: z.number().int(),
  is_bot: z.literal(true),
  first_name: z.string(),
  username: z.string().optional(),
})

export type TelegramBot = z.infer<typeof telegramBotSchema>

export class TelegramApiError extends Error {}

async function telegramRequest<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.TELEGRAM_API_TIMEOUT_MS),
    })
  } catch {
    throw new TelegramApiError(`Telegram ${method} request could not be completed`)
  }

  const parsed = telegramResponseSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !parsed.success || !parsed.data.ok) {
    const description = parsed.success ? parsed.data.description : undefined
    throw new TelegramApiError(description || `Telegram ${method} request failed`)
  }
  return parsed.data.result as T
}

export async function getTelegramBot(token: string): Promise<TelegramBot> {
  const bot = telegramBotSchema.safeParse(await telegramRequest<unknown>(token, 'getMe', {}))
  if (!bot.success) throw new TelegramApiError('Telegram token did not resolve to a valid bot')
  return bot.data
}

export function setTelegramWebhook(token: string, url: string, secretToken: string): Promise<boolean> {
  return telegramRequest<boolean>(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  })
}

export function deleteTelegramWebhook(token: string): Promise<boolean> {
  return telegramRequest<boolean>(token, 'deleteWebhook', { drop_pending_updates: false })
}

export async function sendTelegramMessage(
  token: string,
  input: { chatId: string; text: string; messageThreadId?: number },
): Promise<void> {
  await telegramRequest(token, 'sendMessage', {
    chat_id: input.chatId,
    text: input.text,
    ...(input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}),
  })
}

export async function sendTelegramTyping(token: string, chatId: string, messageThreadId?: number): Promise<void> {
  await telegramRequest(token, 'sendChatAction', {
    chat_id: chatId,
    action: 'typing',
    ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
  })
}

/** Telegram sendMessage accepts at most 4096 characters. Leave headroom and
 * prefer paragraph boundaries while preserving the exact answer text. */
export function splitTelegramText(text: string, maxChars = 4000): string[] {
  const remaining = Array.from(text.trim())
  if (remaining.length === 0) return ['…']
  const parts: string[] = []
  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars).join('')
    const newline = candidate.lastIndexOf('\n')
    const splitAt = newline >= Math.floor(maxChars * 0.55) ? Array.from(candidate.slice(0, newline)).length : maxChars
    parts.push(remaining.splice(0, splitAt).join('').trim())
    while (remaining[0] === '\n') remaining.shift()
  }
  parts.push(remaining.join('').trim())
  return parts.filter(Boolean)
}
