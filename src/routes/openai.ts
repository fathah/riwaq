import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agents } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { complete, streamText, type ChatMessage } from '../lib/llm'
import { prepareChatTurn, ChatError, type Agent } from '../services/chat'
import type { AppEnv } from '../types'

// OpenAI-compatible surface. Point any OpenAI SDK at `<base>/v1`, use the org
// API key as the OpenAI key, and pass the agent id (or name) as `model`.
export const openaiRoute = new Hono<AppEnv>()
openaiRoute.use('*', orgAuth)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function oaiError(message: string, status: 400 | 401 | 404, code: string) {
  return { _status: status, body: { error: { message, type: 'invalid_request_error', code } } }
}

// `model` selects the agent: by id (uuid) or by exact name within the org.
async function resolveAgent(model: string, orgId: string): Promise<Agent | null> {
  if (UUID_RE.test(model)) return getAgentInOrg(model, orgId)
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.name, model)))
    .limit(1)
  return agent ?? null
}

type OAIContentPart = { type?: string; text?: string }
type OAIMessage = { role: string; content: string | OAIContentPart[] | null }

function textOf(content: OAIMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join('')
  return ''
}

// List agents as OpenAI "models" so tooling that queries /v1/models works.
openaiRoute.get('/v1/models', async (c) => {
  const orgId = c.get('orgId')
  const rows = await db.select().from(agents).where(eq(agents.orgId, orgId))
  return c.json({
    object: 'list',
    data: rows.map((a) => ({
      id: a.id,
      object: 'model',
      created: Math.floor(a.createdAt.getTime() / 1000),
      owned_by: orgId,
      name: a.name,
    })),
  })
})

openaiRoute.post('/v1/chat/completions', async (c) => {
  const orgId = c.get('orgId')
  const body = (await c.req.json().catch(() => null)) as
    | {
        model?: string
        messages?: OAIMessage[]
        stream?: boolean
        user?: string
        max_tokens?: number
        temperature?: number
        stream_options?: { include_usage?: boolean }
      }
    | null

  if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
    const e = oaiError('`model` and `messages` are required', 400, 'invalid_request')
    return c.json(e.body, e._status)
  }

  const agent = await resolveAgent(body.model, orgId)
  if (!agent) {
    const e = oaiError(`model '${body.model}' not found (use an agent id or name)`, 404, 'model_not_found')
    return c.json(e.body, e._status)
  }

  // Split the OpenAI messages: client system messages are ignored (the agent's
  // own system prompt + grounding rules are authoritative); the last user
  // message is the query; everything before it becomes turn history.
  const nonSystem = body.messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  let qIdx = -1
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i]!.role === 'user') {
      qIdx = i
      break
    }
  }
  if (qIdx < 0) {
    const e = oaiError('no user message found in `messages`', 400, 'invalid_request')
    return c.json(e.body, e._status)
  }
  const message = textOf(nonSystem[qIdx]!.content)
  const historyOverride: ChatMessage[] = nonSystem.slice(0, qIdx).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: textOf(m.content),
  }))

  let prepared
  try {
    prepared = await prepareChatTurn({
      agent,
      endUserId: body.user || 'openai',
      message,
      historyOverride,
    })
  } catch (err) {
    if (err instanceof ChatError) {
      const e = oaiError(err.message, err.status as 400 | 404, 'invalid_request')
      return c.json(e.body, e._status)
    }
    throw err
  }

  const { system, llmMessages, citations, conversationId, llm, finalize } = prepared
  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '')
  const created = Math.floor(Date.now() / 1000)
  const callOpts = {
    config: llm,
    system,
    messages: llmMessages,
    ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  }

  // Streaming: OpenAI chat.completion.chunk frames, terminated by `[DONE]`.
  if (body.stream) {
    return streamSSE(c, async (sse) => {
      await sse.writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        }),
      })

      let answer = ''
      const s = streamText(callOpts)
      for await (const token of s.tokens) {
        answer += token
        await sse.writeSSE({
          data: JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
          }),
        })
      }
      const usage = await s.usage

      await sse.writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          ...(body.stream_options?.include_usage
            ? {
                usage: {
                  prompt_tokens: usage.inputTokens,
                  completion_tokens: usage.outputTokens,
                  total_tokens: usage.inputTokens + usage.outputTokens,
                },
              }
            : {}),
          // Non-standard extension: retrieval sources + conversation handle.
          riwaq: { conversationId, citations },
        }),
      })
      await sse.writeSSE({ data: '[DONE]' })
      await finalize(answer, usage.inputTokens, usage.outputTokens)
    })
  }

  // Non-streaming.
  const { text: answer, inputTokens, outputTokens } = await complete(callOpts)
  await finalize(answer, inputTokens, outputTokens)

  return c.json({
    id,
    object: 'chat.completion',
    created,
    model: body.model,
    choices: [
      { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
    // Non-standard extension: OpenAI clients ignore unknown fields.
    riwaq: { conversationId, citations },
  })
})
