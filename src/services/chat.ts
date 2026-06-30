import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agents, conversations, messages } from '../db/schema'
import { embedOne } from '../lib/embeddings'
import type { ChatMessage } from '../lib/llm'
import { searchChunks } from './retrieve'
import { recallMemories } from './memory'
import { buildSystemPrompt } from '../prompts/system'
import { learnAfterTurn } from './learn'

const TOP_K = 6
const HISTORY_TURNS = 10

export type Agent = typeof agents.$inferSelect

export type Citation = {
  chunkId: string
  documentId: string
  documentName: string
  knowledgeBaseId: string
  kbName: string
  similarity: number
}

// Thrown for caller-fixable problems (e.g. unknown conversation) so routes can
// translate to the right HTTP status.
export class ChatError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

export type PreparedTurn = {
  conversationId: string
  system: string
  llmMessages: ChatMessage[]
  citations: Citation[]
  model: string
  finalize: (answer: string, inputTokens: number, outputTokens: number) => Promise<void>
}

/**
 * Shared chat pipeline used by both the native endpoint and the OpenAI-compatible
 * endpoint: resolve conversation → embed → retrieve + recall + history → build
 * prompt → persist the user message → hand back everything the caller needs to
 * run the LLM (sync or streaming) and a `finalize` to persist + kick off learning.
 *
 * `historyOverride` lets the OpenAI path supply turn history from the request
 * (the OpenAI contract is client-owned history) instead of loading it from the DB.
 */
export async function prepareChatTurn(input: {
  agent: Agent
  endUserId: string
  message: string
  conversationId?: string
  historyOverride?: ChatMessage[]
}): Promise<PreparedTurn> {
  const { agent, endUserId, message } = input

  // 1. Resolve or create the conversation (must belong to this agent).
  let conversationId = input.conversationId
  if (conversationId) {
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agent.id)))
      .limit(1)
    if (!conv) throw new ChatError('conversation not found', 404)
  } else {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, endUserId })
      .returning({ id: conversations.id })
    conversationId = conv!.id
  }

  // 2. Embed the user message (query side).
  const queryEmbedding = await embedOne(message, 'query')

  // 3 + 4. Retrieve knowledge + recall memory (+ history if not overridden).
  const [retrieved, memoryFacts, dbHistory] = await Promise.all([
    searchChunks(agent.id, queryEmbedding, TOP_K),
    recallMemories(agent.id, queryEmbedding),
    input.historyOverride ? Promise.resolve([] as ChatMessage[]) : loadHistory(conversationId),
  ])
  const history = input.historyOverride ?? dbHistory

  // 5. Compose the prompt.
  const system = buildSystemPrompt({
    agentSystemPrompt: agent.systemPrompt,
    memories: memoryFacts,
    context: retrieved.map((r) => ({ content: r.content, documentName: r.documentName, kbName: r.kbName })),
  })
  const llmMessages: ChatMessage[] = [...history, { role: 'user', content: message }]

  const citations: Citation[] = retrieved.map((r) => ({
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

  return { conversationId, system, llmMessages, citations, model: agent.model, finalize }
}

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
