import { classifyQuestion } from './topics'
import { extractAndStoreMemories } from './memory'
import { extractReminders } from './reminders'
import { resolveLlmConfig } from './llm-config'
import { recordChatUsage } from './usage'
import { env } from '../env'
import type { Usage } from '../lib/llm'

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
  topSimilarity: number
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
  let inputTokens = 0
  let outputTokens = 0
  const add = (u: Usage) => {
    inputTokens += u.inputTokens
    outputTokens += u.outputTokens
  }

  try {
    const { usage } = await classifyQuestion({
      agentId: p.agentId,
      messageId: p.userMessageId,
      question: p.userMessage,
      embedding: p.questionEmbedding,
      topSimilarity: p.topSimilarity,
      llm,
    })
    add(usage)
  } catch (err) {
    console.error('[learn] topic classification failed', err)
    failures.push(err)
  }

  try {
    const usage = await extractAndStoreMemories({
      agentId: p.agentId,
      endUserId: p.endUserId,
      userMessage: p.userMessage,
      assistantMessage: p.assistantMessage,
      llm,
    })
    add(usage)
  } catch (err) {
    console.error('[learn] memory extraction failed', err)
    failures.push(err)
  }

  // Auto-create reminders from dated commitments the user mentioned (renewals,
  // deadlines…). Opt-in via env; isolated like the other learn steps.
  if (env.REMINDER_AUTO_EXTRACT) {
    try {
      const usage = await extractReminders({
        orgId: p.orgId,
        agentId: p.agentId,
        endUserId: p.endUserId,
        userMessage: p.userMessage,
        llm,
      })
      add(usage)
    } catch (err) {
      console.error('[learn] reminder extraction failed', err)
      failures.push(err)
    }
  }

  // Meter background LLM spend against the org's usage/quota, not just chat turns,
  // so tenant spend isn't undercounted. Best-effort: a metering failure must not
  // fail the learning job or trigger a retry.
  if (inputTokens > 0 || outputTokens > 0) {
    await recordChatUsage(p.orgId, inputTokens, outputTokens).catch((err) =>
      console.error('[learn] usage metering failed', err),
    )
  }
  if (failures.length > 0) throw new AggregateError(failures, 'learning job failed')
}
