import { classifyQuestion } from './topics'
import { extractAndStoreMemories } from './memory'
import type { LlmConfig } from '../lib/llm'

/**
 * The async "learning loop". Fire-and-forget after the chat response is sent so
 * it never adds latency. Each piece is independently wrapped so one failure
 * doesn't sink the others. The cheap extraction/labeling calls reuse the turn's
 * resolved LLM config, so this works on any provider. (Upgrade path: durable queue.)
 */
export function learnAfterTurn(opts: {
  agentId: string
  endUserId: string
  userMessageId: string
  userMessage: string
  assistantMessage: string
  questionEmbedding: number[]
  llm: LlmConfig
}): void {
  void (async () => {
    // Topic clustering (reuses the query embedding we already computed).
    try {
      await classifyQuestion({
        agentId: opts.agentId,
        messageId: opts.userMessageId,
        question: opts.userMessage,
        embedding: opts.questionEmbedding,
        llm: opts.llm,
      })
    } catch (err) {
      console.error('[learn] topic classification failed', err)
    }

    // Long-term memory extraction.
    try {
      await extractAndStoreMemories({
        agentId: opts.agentId,
        endUserId: opts.endUserId,
        userMessage: opts.userMessage,
        assistantMessage: opts.assistantMessage,
        llm: opts.llm,
      })
    } catch (err) {
      console.error('[learn] memory extraction failed', err)
    }
  })()
}
