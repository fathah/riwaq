import { classifyQuestion } from './topics'
import { extractAndStoreMemories } from './memory'
import { resolveLlmConfig } from './llm-config'

// Payload for the async "learning" work. It deliberately carries orgId + the
// agent's provider/model rather than a resolved LlmConfig, so the tenant's LLM
// key is NEVER serialized into the job store (Dragonfly) — the worker re-resolves
// (and decrypts) it in-process at run time.
export type LearnPayload = {
  agentId: string
  orgId: string
  endUserId: string
  userMessageId: string
  userMessage: string
  assistantMessage: string
  questionEmbedding: number[]
  provider: string | null
  model: string | null
}

/**
 * The "learning loop": topic clustering + long-term memory extraction. Each piece
 * is wrapped independently so one failure doesn't sink the other. Runs either in a
 * durable worker (survives restarts) or in-process, depending on configuration.
 */
export async function processLearn(p: LearnPayload): Promise<void> {
  const llm = await resolveLlmConfig(p.orgId, { provider: p.provider, model: p.model })
  const failures: unknown[] = []

  try {
    await classifyQuestion({
      agentId: p.agentId,
      messageId: p.userMessageId,
      question: p.userMessage,
      embedding: p.questionEmbedding,
      llm,
    })
  } catch (err) {
    console.error('[learn] topic classification failed', err)
    failures.push(err)
  }

  try {
    await extractAndStoreMemories({
      agentId: p.agentId,
      endUserId: p.endUserId,
      userMessage: p.userMessage,
      assistantMessage: p.assistantMessage,
      llm,
    })
  } catch (err) {
    console.error('[learn] memory extraction failed', err)
    failures.push(err)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'learning job failed')
}
