import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client'
import { agents } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { pageParams } from '../lib/pagination'
import type { ChatMessage } from '../lib/llm'
import { prepareChatTurn, runPrepared, streamPrepared, ChatError, type Agent, type ChatTurnInput } from '../services/chat'
import { serializeResult, createStreamSerializer } from '../serializers'
import type { AppEnv } from '../types'
import { isProd } from '../env'
import { verifyEndUserToken } from '../lib/end-user-token'

// OpenAI-compatible surface. Point any OpenAI SDK at `<base>/v1`, use the org
// API key as the OpenAI key, and pass the agent id (or name) as `model`.
export const openaiRoute = new Hono<AppEnv>()
openaiRoute.use('*', orgAuth)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function oaiError(message: string, status: 400 | 401 | 403 | 404 | 429, code: string) {
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

// Validate the OpenAI chat-completions body instead of type-asserting it, so
// malformed types (max_tokens:"large", messages:[{content:{}}]) fail with a clean
// 400 rather than surfacing as an opaque 500 deep in the SDK. `.passthrough()`
// keeps unknown OpenAI fields (tools, top_p, …) from being rejected.
const oaiContentPart = z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()
const oaiMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(oaiContentPart), z.null()]),
})
const oaiBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(oaiMessageSchema).min(1),
    stream: z.boolean().optional(),
    user: z.string().min(1).optional(),
    max_tokens: z.number().int().positive().max(32_000).optional(),
    max_completion_tokens: z.number().int().positive().max(32_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  })
  .passthrough()

type OAIMessage = z.infer<typeof oaiMessageSchema>

function textOf(content: OAIMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join('')
  return ''
}

// List agents as OpenAI "models" so tooling that queries /v1/models works.
openaiRoute.get('/v1/models', async (c) => {
  const orgId = c.get('orgId')
  const { limit, offset } = pageParams((n) => c.req.query(n))
  const rows = await db.select().from(agents).where(eq(agents.orgId, orgId)).limit(limit).offset(offset)
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
  const parsedBody = oaiBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsedBody.success) {
    const e = oaiError('`model` and `messages` are required and must be well-formed', 400, 'invalid_request')
    return c.json(e.body, e._status)
  }
  const body = parsedBody.data

  const agent = await resolveAgent(body.model, orgId)
  if (!agent) {
    const e = oaiError(`model '${body.model}' not found (use an agent id or name)`, 404, 'model_not_found')
    return c.json(e.body, e._status)
  }
  let endUserId = body.user
  const identityToken = c.req.header('x-end-user-token')
  if (identityToken) {
    try {
      endUserId = verifyEndUserToken(identityToken, orgId).sub
    } catch (err) {
      const e = oaiError(err instanceof Error ? err.message : 'invalid end-user token', 401, 'invalid_end_user_token')
      return c.json(e.body, e._status)
    }
  } else if (isProd) {
    const e = oaiError('X-End-User-Token is required in production', 401, 'missing_end_user_token')
    return c.json(e.body, e._status)
  }
  // Require an explicit identity (token or `user`). Previously an omitted `user`
  // fell back to a single shared 'openai' bucket, merging every anonymous caller's
  // memories and conversations together. Refuse instead of leaking across users.
  if (!endUserId) {
    const e = oaiError('the `user` field (or X-End-User-Token) is required', 400, 'missing_user')
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
  // `max_completion_tokens` is the modern OpenAI field; accept it as an alias.
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  const input: ChatTurnInput = {
    agent,
    endUserId,
    message,
    historyOverride,
    ...(maxTokens ? { maxTokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  }

  // Prepare before opening the stream so pre-flight errors (quota, identity) get a
  // real HTTP status in the OpenAI error envelope, not an SSE frame on a 200.
  let prepared
  try {
    prepared = await prepareChatTurn(input)
  } catch (err) {
    if (err instanceof ChatError) {
      const e = oaiError(err.message, err.status as 400 | 403 | 404 | 429, 'invalid_request')
      return c.json(e.body, e._status)
    }
    throw err
  }
  const runOpts = { ...(maxTokens ? { maxTokens } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}) }

  if (body.stream) {
    const ser = createStreamSerializer('openai', {
      model: body.model,
      includeUsage: !!body.stream_options?.include_usage,
    })
    return streamSSE(c, async (sse) => {
      try {
        for await (const ev of streamPrepared(prepared, runOpts)) {
          for (const frame of ser.frames(ev)) await sse.writeSSE(frame)
        }
      } catch (err) {
        const msg = err instanceof ChatError ? err.message : 'internal error'
        await sse.writeSSE({ data: JSON.stringify({ error: { message: msg, type: 'invalid_request_error' } }) })
        await sse.writeSSE({ data: '[DONE]' })
      }
    })
  }

  const result = await runPrepared(prepared, runOpts)
  return c.json(serializeResult(result, 'openai', body.model) as object)
})
