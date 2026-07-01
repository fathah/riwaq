import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agents } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import type { ChatMessage } from '../lib/llm'
import { runChatTurn, streamChatTurn, ChatError, type Agent, type ChatTurnInput } from '../services/chat'
import { serializeResult, createStreamSerializer } from '../serializers'
import type { AppEnv } from '../types'

// OpenAI-compatible surface. Point any OpenAI SDK at `<base>/v1`, use the org
// API key as the OpenAI key, and pass the agent id (or name) as `model`.
export const openaiRoute = new Hono<AppEnv>()
openaiRoute.use('*', orgAuth)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function oaiError(message: string, status: 400 | 401 | 403 | 404, code: string) {
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

  // OpenAI-in → canonical pipeline → OpenAI-out (same serializer the native route
  // can opt into via ?format=openai). Output shape is identical regardless of which
  // provider backs the agent.
  const input: ChatTurnInput = {
    agent,
    endUserId: body.user || 'openai',
    message,
    historyOverride,
    ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  }

  if (body.stream) {
    const ser = createStreamSerializer('openai', {
      model: body.model,
      includeUsage: !!body.stream_options?.include_usage,
    })
    return streamSSE(c, async (sse) => {
      try {
        for await (const ev of streamChatTurn(input)) {
          for (const frame of ser.frames(ev)) await sse.writeSSE(frame)
        }
      } catch (err) {
        const msg = err instanceof ChatError ? err.message : 'internal error'
        await sse.writeSSE({ data: JSON.stringify({ error: { message: msg, type: 'invalid_request_error' } }) })
        await sse.writeSSE({ data: '[DONE]' })
      }
    })
  }

  try {
    const result = await runChatTurn(input)
    return c.json(serializeResult(result, 'openai', body.model) as object)
  } catch (err) {
    if (err instanceof ChatError) {
      const e = oaiError(err.message, err.status as 400 | 403 | 404, 'invalid_request')
      return c.json(e.body, e._status)
    }
    throw err
  }
})
