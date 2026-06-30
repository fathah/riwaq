import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

// Two inference backends behind one interface. `openai` targets ANY
// OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Together, Ollama, vLLM,
// LM Studio…) via its baseURL; `anthropic` uses the native Claude API.
export type Provider = 'anthropic' | 'openai'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type Usage = { inputTokens: number; outputTokens: number }
export type LLMResult = { text: string } & Usage

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
const anthropicCache = new Map<string, Anthropic>()
function anthropicClient(cfg: LlmConfig): Anthropic {
  if (!cfg.apiKey) throw new Error('No API key for the anthropic provider (set the org LLM key or ANTHROPIC_API_KEY).')
  const k = `${cfg.baseURL ?? ''}|${cfg.apiKey}`
  let c = anthropicCache.get(k)
  if (!c) {
    c = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })
    anthropicCache.set(k, c)
  }
  return c
}

const openaiCache = new Map<string, OpenAI>()
function openaiClient(cfg: LlmConfig): OpenAI {
  if (!cfg.apiKey) throw new Error('No API key for the openai provider (set the org LLM key or OPENAI_API_KEY).')
  const k = `${cfg.baseURL ?? ''}|${cfg.apiKey}`
  let c = openaiCache.get(k)
  if (!c) {
    c = new OpenAI({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })
    openaiCache.set(k, c)
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
  if (opts.provider === 'openai') {
    const res = await openaiClient().chat.completions.create({
      model: opts.model,
      messages: [{ role: 'system', content: opts.system }, ...opts.messages],
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    })
    return {
      text: res.choices[0]?.message?.content ?? '',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    }
  }

  const res = await anthropicClient().messages.create({
    model: opts.model,
    system: opts.system,
    max_tokens: opts.maxTokens ?? 1024,
    messages: opts.messages,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  })
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
}

// Unified streaming handle: drain `tokens` for text deltas, then await `usage`.
export type LLMStream = { tokens: AsyncGenerator<string>; usage: Promise<Usage> }

export function streamText(opts: CallOpts): LLMStream {
  return opts.provider === 'openai' ? openaiStream(opts) : anthropicStream(opts)
}

function anthropicStream(opts: CallOpts): LLMStream {
  let resolve!: (u: Usage) => void
  const usage = new Promise<Usage>((r) => (resolve = r))
  async function* tokens(): AsyncGenerator<string> {
    const s = anthropicClient().messages.stream({
      model: opts.model,
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
    resolve({ inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens })
  }
  return { tokens: tokens(), usage }
}

function openaiStream(opts: CallOpts): LLMStream {
  let resolve!: (u: Usage) => void
  const usage = new Promise<Usage>((r) => (resolve = r))
  async function* tokens(): AsyncGenerator<string> {
    const stream = await openaiClient().chat.completions.create({
      model: opts.model,
      messages: [{ role: 'system', content: opts.system }, ...opts.messages],
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream: true,
      stream_options: { include_usage: true },
    })
    let u: Usage = { inputTokens: 0, outputTokens: 0 }
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
      if (chunk.usage) {
        u = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
      }
    }
    resolve(u)
  }
  return { tokens: tokens(), usage }
}
