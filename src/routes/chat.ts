import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { runChatTurn, streamChatTurn, ChatError } from '../services/chat'
import { serializeResult, createStreamSerializer, parseFormat } from '../serializers'
import type { AppEnv } from '../types'
import { isProd } from '../env'
import { verifyEndUserToken } from '../lib/end-user-token'

export const chatRoute = new Hono<AppEnv>()
chatRoute.use('*', orgAuth)

const chatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  endUserId: z.string().min(1).optional(),
  message: z.string().min(1),
})

// Native contract (our own shape, in and out). `?format=openai` projects the same
// canonical result to the OpenAI shape via the shared serializer.
chatRoute.post('/agents/:id/chat', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const parsed = chatSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  let endUserId = parsed.data.endUserId
  const identityToken = c.req.header('x-end-user-token')
  if (identityToken) {
    try {
      endUserId = verifyEndUserToken(identityToken, orgId).sub
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'invalid end-user token' }, 401)
    }
  } else if (isProd) {
    return c.json({ error: 'X-End-User-Token is required in production' }, 401)
  }
  if (!endUserId) return c.json({ error: 'endUserId is required' }, 400)

  const format = parseFormat(c.req.query('format'))
  const input = {
    agent,
    endUserId,
    message: parsed.data.message,
    ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
  }

  if (c.req.query('stream') === '1') {
    const ser = createStreamSerializer(format, { model: agent.id, includeUsage: true })
    return streamSSE(c, async (sse) => {
      try {
        for await (const ev of streamChatTurn(input)) {
          for (const frame of ser.frames(ev)) await sse.writeSSE(frame)
        }
      } catch (err) {
        const message = err instanceof ChatError ? err.message : 'internal error'
        await sse.writeSSE({ event: 'error', data: JSON.stringify({ error: message }) })
      }
    })
  }

  try {
    const result = await runChatTurn(input)
    return c.json(serializeResult(result, format, agent.id) as object)
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.message }, err.status as 400 | 403 | 404)
    throw err
  }
})
