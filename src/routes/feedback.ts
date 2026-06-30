import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agents, conversations, messages } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

export const feedbackRoute = new Hono<AppEnv>()
feedbackRoute.use('*', orgAuth)

const schema = z.object({ rating: z.enum(['up', 'down']) })

// Thumbs up/down on an assistant message. The message must trace back (via
// conversation → agent) to the caller's org. A 'down' marks a potential KB gap.
feedbackRoute.post('/messages/:id/feedback', async (c) => {
  const orgId = c.get('orgId')
  const messageId = c.req.param('id')

  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  // Verify ownership through the join chain.
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(and(eq(messages.id, messageId), eq(agents.orgId, orgId)))
    .limit(1)
  if (!row) return c.json({ error: 'message not found' }, 404)

  await db.update(messages).set({ feedback: parsed.data.rating }).where(eq(messages.id, messageId))
  return c.json({ ok: true })
})
