import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import { env } from '../env'

// Cache key that doesn't retain the raw credential as a plaintext map key.
const cacheKey = (cfg: { baseURL?: string; apiKey: string }) =>
  createHash('sha256').update(`${cfg.baseURL ?? ''}|${cfg.apiKey}`).digest('hex')

type CachedClient<T> = { client: T; touchedAt: number }

function getCachedClient<T>(cache: Map<string, CachedClient<T>>, key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.touchedAt > env.LLM_CLIENT_CACHE_TTL_SECONDS * 1000) {
    cache.delete(key)
    return undefined
  }
  entry.touchedAt = Date.now()
  return entry.client
}

function cacheClient<T>(cache: Map<string, CachedClient<T>>, key: string, client: T): void {
  const now = Date.now()
  for (const [cachedKey, entry] of cache) {
    if (now - entry.touchedAt > env.LLM_CLIENT_CACHE_TTL_SECONDS * 1000) cache.delete(cachedKey)
  }
  while (cache.size >= env.LLM_CLIENT_CACHE_MAX) {
    let oldestKey: string | undefined
    let oldest = Infinity
    for (const [cachedKey, entry] of cache) {
      if (entry.touchedAt < oldest) {
        oldest = entry.touchedAt
        oldestKey = cachedKey
      }
    }
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
  cache.set(key, { client, touchedAt: now })
}

// Two inference backends behind one interface. `openai` targets ANY
// OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Together, Ollama, vLLM,
// LM Studio…) via its baseURL; `anthropic` uses the native Claude API.
export type Provider = 'anthropic' | 'openai'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type Usage = { inputTokens: number; outputTokens: number }

// Normalized across providers so the output contract never depends on the backend.
export type FinishReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'other'
export type LLMResult = { text: string; finishReason: FinishReason } & Usage

function normalizeAnthropicStop(reason: string | null): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_use'
    default:
      return reason ? 'other' : 'stop'
  }
}

function normalizeOpenAIFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}

// Fully-resolved LLM config for a single call (agent → org → .env already merged).
export type LlmConfig = {
  provider: Provider
  model: string
  apiKey: string
  baseURL?: string // OpenAI-compatible endpoint; optional for anthropic
}

// Sensible cheap default model per provider when nothing else specifies one.
export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
}

// Clients are cached by (baseURL, apiKey) so per-org credentials don't rebuild a
// client on every call, while still isolating one org's endpoint from another's.
const anthropicCache = new Map<string, CachedClient<Anthropic>>()
const openaiCache = new Map<string, CachedClient<OpenAI>>()

/** Drop cached SDK clients after credential or endpoint rotation. */
export function clearLlmClientCache(): void {
  anthropicCache.clear()
  openaiCache.clear()
}

function anthropicClient(cfg: LlmConfig): Anthropic {
  if (!cfg.apiKey) throw new Error('No API key for the anthropic provider (set the org LLM key or ANTHROPIC_API_KEY).')
  const k = cacheKey(cfg)
  let c = getCachedClient(anthropicCache, k)
  if (!c) {
    c = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })
    cacheClient(anthropicCache, k, c)
  }
  return c
}

function openaiClient(cfg: LlmConfig): OpenAI {
  if (!cfg.apiKey) throw new Error('No API key for the openai provider (set the org LLM key or OPENAI_API_KEY).')
  const k = cacheKey(cfg)
  let c = getCachedClient(openaiCache, k)
  if (!c) {
    c = new OpenAI({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })
    cacheClient(openaiCache, k, c)
  }
  return c
}

type CallOpts = {
  config: LlmConfig
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

/** One-shot completion. Same shape regardless of provider. */
export async function complete(opts: CallOpts): Promise<LLMResult> {
  const { config } = opts
  if (config.provider === 'openai') {
    const res = await openaiClient(config).chat.completions.create({
      model: config.model,
      messages: [{ role: 'system', content: opts.system }, ...opts.messages],
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    })
    return {
      text: res.choices[0]?.message?.content ?? '',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      finishReason: normalizeOpenAIFinish(res.choices[0]?.finish_reason),
    }
  }

  const res = await anthropicClient(config).messages.create({
    model: config.model,
    system: opts.system,
    max_tokens: opts.maxTokens ?? 1024,
    messages: opts.messages,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  })
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return {
    text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    finishReason: normalizeAnthropicStop(res.stop_reason),
  }
}

// Unified streaming handle: drain `tokens` for text deltas, then await `done`.
export type StreamDone = Usage & { finishReason: FinishReason }
export type LLMStream = { tokens: AsyncGenerator<string>; done: Promise<StreamDone> }

export function streamText(opts: CallOpts): LLMStream {
  return opts.config.provider === 'openai' ? openaiStream(opts) : anthropicStream(opts)
}

function anthropicStream(opts: CallOpts): LLMStream {
  let resolve!: (d: StreamDone) => void
  const done = new Promise<StreamDone>((r) => (resolve = r))
  async function* tokens(): AsyncGenerator<string> {
    const s = anthropicClient(opts.config).messages.stream({
      model: opts.config.model,
      system: opts.system,
      max_tokens: opts.maxTokens ?? 1024,
      messages: opts.messages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    })
    for await (const event of s) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text
      }
    }
    const final = await s.finalMessage()
    resolve({
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      finishReason: normalizeAnthropicStop(final.stop_reason),
    })
  }
  return { tokens: tokens(), done }
}

function openaiStream(opts: CallOpts): LLMStream {
  let resolve!: (d: StreamDone) => void
  const done = new Promise<StreamDone>((r) => (resolve = r))
  async function* tokens(): AsyncGenerator<string> {
    const stream = await openaiClient(opts.config).chat.completions.create({
      model: opts.config.model,
      messages: [{ role: 'system', content: opts.system }, ...opts.messages],
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream: true,
      stream_options: { include_usage: true },
    })
    let d: StreamDone = { inputTokens: 0, outputTokens: 0, finishReason: 'stop' }
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
      const fr = chunk.choices[0]?.finish_reason
      if (fr) d.finishReason = normalizeOpenAIFinish(fr)
      if (chunk.usage) {
        d.inputTokens = chunk.usage.prompt_tokens
        d.outputTokens = chunk.usage.completion_tokens
      }
    }
    resolve(d)
  }
  return { tokens: tokens(), done }
}
