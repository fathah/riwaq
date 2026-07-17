import { z } from 'zod'
import { env } from '../env'

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
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

export class TelegramApiError extends Error {
  constructor(message: string, public errorCode?: number) {
    super(message)
  }
}

async function telegramRequest<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? env.TELEGRAM_API_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    throw new TelegramApiError(`Telegram ${method} request could not be completed`)
  }

  const parsed = telegramResponseSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !parsed.success || !parsed.data.ok) {
    const description = parsed.success ? parsed.data.description : undefined
    const errorCode = parsed.success ? parsed.data.error_code : response.status
    throw new TelegramApiError(description || `Telegram ${method} request failed`, errorCode)
  }
  return parsed.data.result as T
}

export async function getTelegramBot(token: string): Promise<TelegramBot> {
  const bot = telegramBotSchema.safeParse(await telegramRequest<unknown>(token, 'getMe', {}))
  if (!bot.success) throw new TelegramApiError('Telegram token did not resolve to a valid bot')
  return bot.data
}

export function deleteTelegramWebhook(token: string): Promise<boolean> {
  return telegramRequest<boolean>(token, 'deleteWebhook', { drop_pending_updates: false })
}

/** Fetch Telegram updates over one outbound long-poll request. Telegram permits
 * only one active poller per bot token, enforced by the polling supervisor. */
export async function getTelegramUpdates(
  token: string,
  input: { offset?: number; timeoutSeconds: number; signal: AbortSignal },
): Promise<TelegramUpdate[]> {
  const result = await telegramRequest<unknown>(
    token,
    'getUpdates',
    {
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      timeout: input.timeoutSeconds,
      allowed_updates: ['message'],
    },
    {
      // Give Telegram enough time to finish the long poll plus normal network
      // overhead. The caller's signal still aborts immediately on shutdown.
      timeoutMs: input.timeoutSeconds * 1000 + env.TELEGRAM_API_TIMEOUT_MS,
      signal: input.signal,
    },
  )
  const updates = z.array(telegramUpdateSchema).safeParse(result)
  if (!updates.success) throw new TelegramApiError('Telegram getUpdates returned an invalid response')
  return updates.data
}

export async function sendTelegramMessage(
  token: string,
  input: {
    chatId: string
    text: string
    messageThreadId?: number
    parseMode?: 'HTML'
    fallbackText?: string
  },
): Promise<void> {
  const thread = input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}
  try {
    await telegramRequest(token, 'sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      ...thread,
    })
  } catch (error) {
    // A malformed or newly unsupported entity should never prevent delivery.
    // Telegram reports formatting/entity errors as HTTP 400.
    if (!input.parseMode || !(error instanceof TelegramApiError) || error.errorCode !== 400) throw error
    await telegramRequest(token, 'sendMessage', {
      chat_id: input.chatId,
      text: input.fallbackText ?? input.text,
      ...thread,
    })
  }
}

export async function sendTelegramTyping(
  token: string,
  input: { chatId: string; messageThreadId?: number; signal?: AbortSignal },
): Promise<void> {
  await telegramRequest(token, 'sendChatAction', {
    chat_id: input.chatId,
    action: 'typing',
    ...(input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}),
  }, { signal: input.signal })
}

function waitForTypingRefresh(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    timer.unref()
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Keep Telegram's short-lived typing action visible until stop() is called. */
export function startTelegramTyping(
  token: string,
  input: { chatId: string; messageThreadId?: number; refreshMs?: number },
): { stop: () => Promise<void> } {
  const abort = new AbortController()
  const refreshMs = input.refreshMs ?? 4_000
  const done = (async () => {
    while (!abort.signal.aborted) {
      await sendTelegramTyping(token, {
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        signal: abort.signal,
      }).catch(() => {})
      await waitForTypingRefresh(refreshMs, abort.signal)
    }
  })()
  return {
    stop: async () => {
      abort.abort()
      await done
    },
  }
}

export type TelegramFormattedPart = {
  html: string
  plainText: string
}

function escapeTelegramHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function safeTelegramHref(href: string): string | null {
  const value = href.trim()
  if (!/^(?:https?:\/\/|mailto:|tg:\/\/)/i.test(value)) return null
  return escapeTelegramHtml(value).replaceAll('"', '&quot;')
}

/** Render the deliberately small Markdown subset commonly emitted by models
 * into Telegram's supported HTML. Raw HTML is always escaped. */
function renderTelegramInline(source: string): { html: string; plainText: string } {
  let html = ''
  let plainText = ''
  let cursor = 0

  while (cursor < source.length) {
    if (source[cursor] === '\\' && cursor + 1 < source.length) {
      const literal = source[cursor + 1]!
      html += escapeTelegramHtml(literal)
      plainText += literal
      cursor += 2
      continue
    }

    const markers: Array<{ marker: string; tag: string }> = [
      { marker: '**', tag: 'b' },
      { marker: '__', tag: 'b' },
      { marker: '~~', tag: 's' },
      { marker: '*', tag: 'i' },
      { marker: '_', tag: 'i' },
    ]
    const emphasis = markers.find(({ marker }) => source.startsWith(marker, cursor))
    if (emphasis) {
      const end = source.indexOf(emphasis.marker, cursor + emphasis.marker.length)
      if (end > cursor + emphasis.marker.length) {
        const inner = renderTelegramInline(source.slice(cursor + emphasis.marker.length, end))
        html += `<${emphasis.tag}>${inner.html}</${emphasis.tag}>`
        plainText += inner.plainText
        cursor = end + emphasis.marker.length
        continue
      }
    }

    if (source[cursor] === '`') {
      const end = source.indexOf('`', cursor + 1)
      if (end > cursor + 1) {
        const code = source.slice(cursor + 1, end)
        html += `<code>${escapeTelegramHtml(code)}</code>`
        plainText += code
        cursor = end + 1
        continue
      }
    }

    if (source[cursor] === '[') {
      const labelEnd = source.indexOf('](', cursor + 1)
      const hrefEnd = labelEnd >= 0 ? source.indexOf(')', labelEnd + 2) : -1
      if (labelEnd > cursor + 1 && hrefEnd > labelEnd + 2) {
        const label = renderTelegramInline(source.slice(cursor + 1, labelEnd))
        const rawHref = source.slice(labelEnd + 2, hrefEnd)
        const href = safeTelegramHref(rawHref)
        html += href ? `<a href="${href}">${label.html}</a>` : `${label.html} (${escapeTelegramHtml(rawHref)})`
        plainText += `${label.plainText} (${rawHref})`
        cursor = hrefEnd + 1
        continue
      }
    }

    const character = source[cursor]!
    html += escapeTelegramHtml(character)
    plainText += character
    cursor += 1
  }

  return { html, plainText }
}

function splitByCodePoints(text: string, maxChars: number): string[] {
  const characters = Array.from(text)
  const parts: string[] = []
  for (let cursor = 0; cursor < characters.length; cursor += maxChars) {
    parts.push(characters.slice(cursor, cursor + maxChars).join(''))
  }
  return parts
}

/** Convert canonical Markdown to independently valid Telegram HTML messages.
 * Chunking happens inside the adapter so tags and fenced code never cross a
 * Telegram message boundary. */
export function renderTelegramMarkdown(markdown: string, maxChars = 3900): TelegramFormattedPart[] {
  const lines = markdown.trim().replaceAll('\r\n', '\n').split('\n')
  const blocks: TelegramFormattedPart[] = []

  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!
    const fence = line.match(/^\s*```[^`]*$/)
    if (fence) {
      const codeLines: string[] = []
      cursor += 1
      while (cursor < lines.length && !/^\s*```\s*$/.test(lines[cursor]!)) {
        codeLines.push(lines[cursor]!)
        cursor += 1
      }
      for (const code of splitByCodePoints(codeLines.join('\n') || ' ', maxChars)) {
        blocks.push({ html: `<pre>${escapeTelegramHtml(code)}</pre>`, plainText: code })
      }
      continue
    }

    if (!line.trim()) {
      blocks.push({ html: '', plainText: '' })
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue
    if (/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line)) continue

    let prefix = ''
    let content = line.trim()
    let wrapper: 'b' | 'blockquote' | null = null
    const heading = content.match(/^#{1,6}\s+(.+)$/)
    const unordered = content.match(/^[-+*]\s+(.+)$/)
    const ordered = content.match(/^(\d+)[.)]\s+(.+)$/)
    const quote = content.match(/^>\s?(.*)$/)
    if (heading) {
      content = heading[1]!
      wrapper = 'b'
    } else if (unordered) {
      prefix = '• '
      content = unordered[1]!
    } else if (ordered) {
      prefix = `${ordered[1]}. `
      content = ordered[2]!
    } else if (quote) {
      content = quote[1]!
      wrapper = 'blockquote'
    } else if (content.startsWith('|') && content.endsWith('|')) {
      content = content.slice(1, -1).split('|').map((cell) => cell.trim()).join(' | ')
    }

    const rendered = renderTelegramInline(content)
    let block: TelegramFormattedPart = {
      html: `${escapeTelegramHtml(prefix)}${rendered.html}`,
      plainText: `${prefix}${rendered.plainText}`,
    }
    if (wrapper) block = { ...block, html: `<${wrapper}>${block.html}</${wrapper}>` }

    if (Array.from(block.plainText).length <= maxChars) {
      blocks.push(block)
    } else {
      // Very long single lines are delivered safely, sacrificing only inline
      // styling for that line rather than risking a rejected message.
      blocks.push(...splitByCodePoints(block.plainText, maxChars).map((part) => ({
        html: escapeTelegramHtml(part),
        plainText: part,
      })))
    }
  }

  const messages: TelegramFormattedPart[] = []
  let current: TelegramFormattedPart = { html: '', plainText: '' }
  for (const block of blocks) {
    const separator = current.plainText ? '\n' : ''
    const nextLength = Array.from(`${current.plainText}${separator}${block.plainText}`).length
    if (current.plainText && block.plainText && nextLength > maxChars) {
      messages.push(current)
      current = { html: block.html, plainText: block.plainText }
      continue
    }
    current = {
      html: `${current.html}${separator}${block.html}`,
      plainText: `${current.plainText}${separator}${block.plainText}`,
    }
  }
  if (current.plainText) messages.push(current)
  return messages.length ? messages : [{ html: '…', plainText: '…' }]
}
