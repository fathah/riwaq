import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { conversations, messages } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { embedOne } from '../lib/embeddings'
import { complete, stream, type ChatMessage } from '../lib/llm'
import { searchChunks } from '../services/retrieve'
import { recallMemories } from '../services/memory'
import { buildSystemPrompt } from '../prompts/system'
import { learnAfterTurn } from '../services/learn'
import type { AppEnv } from '../types'

export const chatRoute = new Hono<AppEnv>()
chatRoute.use('*', orgAuth)

const TOP_K = 6
const HISTORY_TURNS = 10

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
  const { endUserId, message } = parsed.data

  // 1. Resolve or create the conversation (must belong to this agent).
  let conversationId = parsed.data.conversationId
  if (conversationId) {
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agent.id)))
      .limit(1)
    if (!conv) return c.json({ error: 'conversation not found' }, 404)
  } else {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, endUserId })
      .returning({ id: conversations.id })
    conversationId = conv!.id
  }

  // 2. Embed the user message (query side).
  const queryEmbedding = await embedOne(message, 'query')

  // 3 + 4. Retrieve knowledge + recall memory, in parallel.
  const [retrieved, memoryFacts, history] = await Promise.all([
    searchChunks(agent.id, queryEmbedding, TOP_K),
    recallMemories(agent.id, queryEmbedding),
    loadHistory(conversationId),
  ])

  // 5. Compose the prompt.
  const system = buildSystemPrompt({
    agentSystemPrompt: agent.systemPrompt,
    memories: memoryFacts,
    context: retrieved.map((r) => ({ content: r.content, documentName: r.documentName, kbName: r.kbName })),
  })
  const llmMessages: ChatMessage[] = [...history, { role: 'user', content: message }]

  const citations = retrieved.map((r) => ({
    chunkId: r.id,
    documentId: r.documentId,
    documentName: r.documentName,
    knowledgeBaseId: r.knowledgeBaseId,
    kbName: r.kbName,
    similarity: Number(r.similarity.toFixed(4)),
  }))
  const usedChunkIds = retrieved.map((r) => r.id)

  // Persist the user message now so the learning loop can reference it.
  const [userMsg] = await db
    .insert(messages)
    .values({ conversationId, role: 'user', content: message })
    .returning({ id: messages.id })

  const finalize = async (answer: string, inputTokens: number, outputTokens: number) => {
    await db.insert(messages).values({
      conversationId: conversationId!,
      role: 'assistant',
      content: answer,
      usedChunkIds,
      tokens: inputTokens + outputTokens,
    })
    learnAfterTurn({
      agentId: agent.id,
      endUserId,
      userMessageId: userMsg!.id,
      userMessage: message,
      assistantMessage: answer,
      questionEmbedding: queryEmbedding,
      model: agent.model,
    })
  }

  // 6/7. Streaming path (SSE): `meta` first (conversationId + citations), then
  // `token` deltas, then `done`. Persistence + learning run after the stream.
  if (c.req.query('stream') === '1') {
    return streamSSE(c, async (sse) => {
      await sse.writeSSE({ event: 'meta', data: JSON.stringify({ conversationId, citations }) })
      let answer = ''
      const s = stream({ model: agent.model, system, messages: llmMessages })
      for await (const event of s) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          answer += event.delta.text
          await sse.writeSSE({ event: 'token', data: event.delta.text })
        }
      }
      const final = await s.finalMessage()
      await sse.writeSSE({ event: 'done', data: JSON.stringify({ answer }) })
      await finalize(answer, final.usage.input_tokens, final.usage.output_tokens)
    })
  }

  // 6/7. Non-streaming path.
  const { text: answer, inputTokens, outputTokens } = await complete({
    model: agent.model,
    system,
    messages: llmMessages,
  })
  await finalize(answer, inputTokens, outputTokens)

  return c.json({ answer, citations, conversationId })
})

async function loadHistory(conversationId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_TURNS)
  return rows
    .reverse()
    .map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }))
}
