import { randomUUID } from 'node:crypto'
import type { ChatResult, ChatStreamEvent, Citation } from './services/chat'
import type { FinishReason } from './lib/llm'

// One place that owns every wire format. The canonical ChatResult/ChatStreamEvent
// is the source of truth; each format here is a pure projection of it. Adding a
// new format = add a branch here; nothing in the pipeline changes.
export type OutputFormat = 'native' | 'openai'

export function parseFormat(value: string | undefined): OutputFormat {
  return value === 'openai' ? 'openai' : 'native'
}

function toOpenAIFinish(r: FinishReason): string {
  switch (r) {
    case 'tool_use':
      return 'tool_calls'
    case 'content_filter':
      return 'content_filter'
    case 'length':
      return 'length'
    default:
      return 'stop'
  }
}

// ---- non-streaming ----

type NativeBody = {
  conversationId: string
  answer: string
  citations: Citation[]
  model: string
  usage: { inputTokens: number; outputTokens: number }
  finishReason: FinishReason
}

function toNative(r: ChatResult): NativeBody {
  return {
    conversationId: r.conversationId,
    answer: r.answer,
    citations: r.citations,
    model: r.model,
    usage: r.usage,
    finishReason: r.finishReason,
  }
}

function toOpenAICompletion(r: ChatResult, requestedModel: string) {
  return {
    id: 'chatcmpl-' + randomUUID().replace(/-/g, ''),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      { index: 0, message: { role: 'assistant', content: r.answer }, finish_reason: toOpenAIFinish(r.finishReason) },
    ],
    usage: {
      prompt_tokens: r.usage.inputTokens,
      completion_tokens: r.usage.outputTokens,
      total_tokens: r.usage.inputTokens + r.usage.outputTokens,
    },
    // Non-standard extension; OpenAI clients ignore unknown keys.
    riwaq: { conversationId: r.conversationId, citations: r.citations },
  }
}

export function serializeResult(r: ChatResult, format: OutputFormat, requestedModel?: string): unknown {
  return format === 'openai' ? toOpenAICompletion(r, requestedModel ?? r.model) : toNative(r)
}

// ---- streaming ----

// An SSE frame: native uses named events, OpenAI uses bare `data:` lines.
export type SSEFrame = { event?: string; data: string }

export type StreamSerializer = { frames: (ev: ChatStreamEvent) => SSEFrame[] }

export function createStreamSerializer(
  format: OutputFormat,
  opts: { model: string; includeUsage?: boolean },
): StreamSerializer {
  if (format === 'native') {
    return {
      frames: (ev) => {
        switch (ev.type) {
          case 'meta':
            return [{ event: 'meta', data: JSON.stringify({ conversationId: ev.conversationId, citations: ev.citations, model: ev.model }) }]
          case 'token':
            return [{ event: 'token', data: ev.text }]
          case 'done':
            return [
              {
                event: 'done',
                data: JSON.stringify({
                  answer: ev.result.answer,
                  usage: ev.result.usage,
                  finishReason: ev.result.finishReason,
                }),
              },
            ]
        }
      },
    }
  }

  // OpenAI: chat.completion.chunk frames sharing one id/created, ended by [DONE].
  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '')
  const created = Math.floor(Date.now() / 1000)
  const base = { id, object: 'chat.completion.chunk', created, model: opts.model }

  return {
    frames: (ev) => {
      switch (ev.type) {
        case 'meta':
          return [{ data: JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) }]
        case 'token':
          return [{ data: JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] }) }]
        case 'done':
          return [
            {
              data: JSON.stringify({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: toOpenAIFinish(ev.result.finishReason) }],
                ...(opts.includeUsage
                  ? {
                      usage: {
                        prompt_tokens: ev.result.usage.inputTokens,
                        completion_tokens: ev.result.usage.outputTokens,
                        total_tokens: ev.result.usage.inputTokens + ev.result.usage.outputTokens,
                      },
                    }
                  : {}),
                riwaq: { conversationId: ev.result.conversationId, citations: ev.result.citations },
              }),
            },
            { data: '[DONE]' },
          ]
      }
    },
  }
}
