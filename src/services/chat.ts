import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agents, conversations, messages } from '../db/schema'
import { embedOne } from '../lib/embeddings'
import { complete, streamText, type ChatMessage, type FinishReason, type LlmConfig } from '../lib/llm'
import { searchChunks } from './retrieve'
import { recallMemories } from './memory'
import { resolveLlmConfig } from './llm-config'
import { buildSystemPrompt } from '../prompts/system'
import { enqueueLearn } from '../lib/queue'
import { assertChatQuota, recordChatUsage, QuotaExceededError } from './usage'

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
  llm: LlmConfig
  finalize: (answer: string, inputTokens: number, outputTokens: number) => Promise<void>
}

// One input shape for every entrypoint (native, OpenAI-compat, future adapters).
export type ChatTurnInput = {
  agent: Agent
  endUserId: string
  message: string
  conversationId?: string
  historyOverride?: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

// THE canonical chat result. Every serializer (native / OpenAI / future) reads
// only this — it carries no provider-specific fields, so the output structure is
// independent of which backend produced it and stable as new backends are added.
export type ChatResult = {
  conversationId: string
  answer: string
  citations: Citation[]
  model: string
  usage: { inputTokens: number; outputTokens: number }
  finishReason: FinishReason
}

// Canonical streaming events (provider- and format-agnostic).
export type ChatStreamEvent =
  | { type: 'meta'; conversationId: string; citations: Citation[]; model: string }
  | { type: 'token'; text: string }
  | { type: 'done'; result: ChatResult }

/**
 * Shared chat pipeline used by both the native endpoint and the OpenAI-compatible
 * endpoint: resolve conversation → embed → retrieve + recall + history → build
 * prompt → persist the user message → hand back everything the caller needs to
 * run the LLM (sync or streaming) and a `finalize` to persist + kick off learning.
 *
 * `historyOverride` lets the OpenAI path supply turn history from the request
 * (the OpenAI contract is client-owned history) instead of loading it from the DB.
 */
export async function prepareChatTurn(input: ChatTurnInput): Promise<PreparedTurn> {
  const { agent, endUserId, message } = input
  try {
    await assertChatQuota(agent.orgId)
  } catch (err) {
    if (err instanceof QuotaExceededError) throw new ChatError(err.message, 429)
    throw err
  }

  // 1. Resolve or create the conversation. It must belong to this agent AND to
  // the same end user. A caller-supplied conversationId is NOT proof of identity,
  // so we compare the stored endUserId and refuse a mismatch — otherwise one user
  // could resume another user's conversation (and mis-attribute new memories).
  let conversationId = input.conversationId
  if (conversationId) {
    const [conv] = await db
      .select({ id: conversations.id, endUserId: conversations.endUserId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agent.id)))
      .limit(1)
    if (!conv) throw new ChatError('conversation not found', 404)
    if (conv.endUserId !== endUserId)
      throw new ChatError('conversation does not belong to this end user', 403)
  } else {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, endUserId })
      .returning({ id: conversations.id })
    conversationId = conv!.id
  }

  // Resolve the effective LLM config (agent → org → .env).
  const llm = await resolveLlmConfig(agent.orgId, { provider: agent.provider, model: agent.model })

  // 2. Embed the user message (query side).
  const queryEmbedding = await embedOne(message, 'query')

  // 3 + 4. Retrieve knowledge + recall memory (+ history if not overridden).
  const [retrieved, memoryFacts, dbHistory] = await Promise.all([
    searchChunks(agent.id, queryEmbedding, TOP_K),
    recallMemories(agent.id, endUserId, queryEmbedding),
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
    await recordChatUsage(agent.orgId, inputTokens, outputTokens)
    // Non-blocking: enqueue durable learning (or run in-process if no queue). The
    // payload carries orgId + provider/model, not the resolved key, so no secret
    // is written to the job store.
    void enqueueLearn({
      agentId: agent.id,
      orgId: agent.orgId,
      endUserId,
      userMessageId: userMsg!.id,
      userMessage: message,
      assistantMessage: answer,
      questionEmbedding: queryEmbedding,
      provider: agent.provider,
      model: agent.model,
    }).catch((err) => console.error('[learn] enqueue failed', err))
  }

  return { conversationId, system, llmMessages, citations, llm, finalize }
}

/**
 * Run a full non-streaming turn and return the canonical {@link ChatResult}.
 * Serializers turn this into whatever wire format the caller asked for.
 */
export async function runChatTurn(input: ChatTurnInput): Promise<ChatResult> {
  const { system, llmMessages, citations, conversationId, llm, finalize } = await prepareChatTurn(input)
  const res = await complete({
    config: llm,
    system,
    messages: llmMessages,
    ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  })
  await finalize(res.text, res.inputTokens, res.outputTokens)
  return {
    conversationId,
    answer: res.text,
    citations,
    model: llm.model,
    usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens },
    finishReason: res.finishReason,
  }
}

/**
 * Run a streaming turn, yielding canonical {@link ChatStreamEvent}s (meta → token*
 * → done). Persistence + learning happen before the final `done` event. Serializers
 * map these events to native SSE or OpenAI chunks.
 */
export async function* streamChatTurn(input: ChatTurnInput): AsyncGenerator<ChatStreamEvent> {
  const { system, llmMessages, citations, conversationId, llm, finalize } = await prepareChatTurn(input)
  yield { type: 'meta', conversationId, citations, model: llm.model }

  let answer = ''
  const s = streamText({
    config: llm,
    system,
    messages: llmMessages,
    ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  })
  for await (const token of s.tokens) {
    answer += token
    yield { type: 'token', text: token }
  }
  const done = await s.done
  await finalize(answer, done.inputTokens, done.outputTokens)

  yield {
    type: 'done',
    result: {
      conversationId,
      answer,
      citations,
      model: llm.model,
      usage: { inputTokens: done.inputTokens, outputTokens: done.outputTokens },
      finishReason: done.finishReason,
    },
  }
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
