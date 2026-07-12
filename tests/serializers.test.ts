import { describe, it, expect } from 'vitest'
import { serializeResult, createStreamSerializer, parseFormat } from '../src/serializers'
import type { ChatResult, ChatStreamEvent } from '../src/services/chat'

const result: ChatResult = {
  conversationId: 'conv-1',
  answer: 'hello world',
  citations: [
    { chunkId: 'c1', documentId: 'd1', documentName: 'doc', knowledgeBaseId: 'kb1', kbName: 'KB', similarity: 0.9 },
  ],
  model: 'agent-model',
  usage: { inputTokens: 10, outputTokens: 5 },
  finishReason: 'stop',
}

describe('non-streaming serializers', () => {
  it('native projection carries the canonical fields verbatim', () => {
    const body = serializeResult(result, 'native') as any
    expect(body.conversationId).toBe('conv-1')
    expect(body.answer).toBe('hello world')
    expect(body.citations).toHaveLength(1)
    expect(body.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('openai projection matches the chat.completion shape + riwaq extension', () => {
    const body = serializeResult(result, 'openai', 'requested-model') as any
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('requested-model')
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'hello world' })
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    // Non-standard extension preserves retrieval sources for OpenAI clients.
    expect(body.riwaq.conversationId).toBe('conv-1')
    expect(body.riwaq.citations).toHaveLength(1)
  })

  it('parseFormat defaults to native and recognizes openai', () => {
    expect(parseFormat(undefined)).toBe('native')
    expect(parseFormat('anything')).toBe('native')
    expect(parseFormat('openai')).toBe('openai')
  })
})

const events: ChatStreamEvent[] = [
  { type: 'meta', conversationId: 'conv-1', citations: result.citations, model: 'agent-model' },
  { type: 'token', text: 'hel' },
  { type: 'token', text: 'lo' },
  { type: 'done', result },
]

describe('streaming serializers', () => {
  it('openai stream emits chunk frames sharing one id and ends with [DONE]', () => {
    const ser = createStreamSerializer('openai', { model: 'm', includeUsage: true })
    const frames = events.flatMap((e) => ser.frames(e))
    const dataFrames = frames.map((f) => f.data)

    // Last frame is the [DONE] sentinel.
    expect(dataFrames.at(-1)).toBe('[DONE]')

    const parsed = dataFrames.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d))
    const ids = new Set(parsed.map((p) => p.id))
    expect(ids.size).toBe(1) // one id across the whole stream
    expect(parsed.every((p) => p.object === 'chat.completion.chunk')).toBe(true)

    // First (meta) frame opens the assistant role delta.
    expect(parsed[0].choices[0].delta).toEqual({ role: 'assistant' })
    // Token frames carry content deltas.
    expect(parsed[1].choices[0].delta.content).toBe('hel')
    // The finishing frame carries finish_reason + usage (include_usage=true).
    const doneFrame = parsed.at(-1)
    expect(doneFrame.choices[0].finish_reason).toBe('stop')
    expect(doneFrame.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it('native stream uses named events (meta/token/done)', () => {
    const ser = createStreamSerializer('native', { model: 'm' })
    const frames = events.flatMap((e) => ser.frames(e))
    expect(frames.map((f) => f.event)).toEqual(['meta', 'token', 'token', 'done'])
    expect(frames[1].data).toBe('hel')
    const done = JSON.parse(frames.at(-1)!.data)
    expect(done.answer).toBe('hello world')
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })
})
