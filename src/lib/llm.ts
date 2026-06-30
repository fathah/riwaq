import Anthropic from '@anthropic-ai/sdk'
import { env } from '../env'

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

let _client: Anthropic | null = null
export function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot call Claude.')
  }
  if (!_client) _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  return _client
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** One-shot completion. Returns the concatenated text and token usage. */
export async function complete(opts: {
  model?: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await anthropic().messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    system: opts.system,
    max_tokens: opts.maxTokens ?? 1024,
    messages: opts.messages,
  })
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return {
    text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  }
}

/** Streaming variant — yields text deltas. Used by the chat SSE path. */
export function stream(opts: { model?: string; system: string; messages: ChatMessage[]; maxTokens?: number }) {
  return anthropic().messages.stream({
    model: opts.model ?? DEFAULT_MODEL,
    system: opts.system,
    max_tokens: opts.maxTokens ?? 1024,
    messages: opts.messages,
  })
}
