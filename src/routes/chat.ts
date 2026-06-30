import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { complete, streamText } from '../lib/llm'
import { prepareChatTurn, ChatError } from '../services/chat'
import type { AppEnv } from '../types'

export const chatRoute = new Hono<AppEnv>()
chatRoute.use('*', orgAuth)

const chatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  endUserId: z.string().min(1),
  message: z.string().min(1),
})

chatRoute.post('/agents/:id/chat', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const parsed = chatSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  let prepared
  try {
    prepared = await prepareChatTurn({
      agent,
      endUserId: parsed.data.endUserId,
      message: parsed.data.message,
      ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
    })
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.message }, err.status as 400 | 404)
    throw err
  }

  const { system, llmMessages, citations, conversationId, provider, model, finalize } = prepared

  // Streaming (SSE): `meta` first (conversationId + citations), then `token`
  // deltas, then `done`. Persistence + learning run after the stream.
  if (c.req.query('stream') === '1') {
    return streamSSE(c, async (sse) => {
      await sse.writeSSE({ event: 'meta', data: JSON.stringify({ conversationId, citations }) })
      let answer = ''
      const s = streamText({ provider, model, system, messages: llmMessages })
      for await (const token of s.tokens) {
        answer += token
        await sse.writeSSE({ event: 'token', data: token })
      }
      const usage = await s.usage
      await sse.writeSSE({ event: 'done', data: JSON.stringify({ answer }) })
      await finalize(answer, usage.inputTokens, usage.outputTokens)
    })
  }

  const { text: answer, inputTokens, outputTokens } = await complete({ provider, model, system, messages: llmMessages })
  await finalize(answer, inputTokens, outputTokens)
  return c.json({ answer, citations, conversationId })
})
