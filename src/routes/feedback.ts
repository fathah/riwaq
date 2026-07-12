import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, lt } from 'drizzle-orm'
import { db } from '../db/client'
import { agents, conversations, messages } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { isUuid } from '../lib/uuid'
import { captureUpvote } from '../services/learning'
import type { AppEnv } from '../types'

export const feedbackRoute = new Hono<AppEnv>()
feedbackRoute.use('*', orgAuth)

const schema = z.object({ rating: z.enum(['up', 'down']) })

// Thumbs up/down on an assistant message. The message must trace back (via
// conversation → agent) to the caller's org. A 'down' marks a potential KB gap;
// an 'up' feeds the self-learning loop (endorses the Q&A for promotion).
feedbackRoute.post('/messages/:id/feedback', async (c) => {
  const orgId = c.get('orgId')
  const messageId = c.req.param('id')
  if (!isUuid(messageId)) return c.json({ error: 'message not found' }, 404)

  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  // Verify ownership through the join chain. Feedback only applies to assistant
  // answers — rating a user message would pollute the signals. Pull the context
  // the learning loop needs (agent, end user, answer, timing) in the same query.
  const [row] = await db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
      conversationId: messages.conversationId,
      agentId: conversations.agentId,
      endUserId: conversations.endUserId,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(and(eq(messages.id, messageId), eq(agents.orgId, orgId), eq(messages.role, 'assistant')))
    .limit(1)
  if (!row) return c.json({ error: 'message not found' }, 404)

  await db.update(messages).set({ feedback: parsed.data.rating }).where(eq(messages.id, messageId))

  if (parsed.data.rating === 'up') {
    // Resolve the question that prompted this answer (the latest user message
    // before it in the conversation), then feed the endorsement into the
    // self-learning loop. Fire-and-forget + guarded so it never delays or fails
    // the feedback write.
    const [question] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, row.conversationId),
          eq(messages.role, 'user'),
          lt(messages.createdAt, row.createdAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
    if (question) {
      void captureUpvote({
        orgId,
        agentId: row.agentId,
        endUserId: row.endUserId,
        question: question.content,
        answer: row.content,
      }).catch((err) => console.error('[learning] capture from feedback failed', err))
    }
  }

  return c.json({ ok: true })
})
