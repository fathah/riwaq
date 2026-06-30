import { classifyQuestion } from './topics'
import { extractAndStoreMemories } from './memory'

/**
 * The async "learning loop". Fire-and-forget after the chat response is sent so
 * it never adds latency. Each piece is independently wrapped so one failure
 * doesn't sink the others. (Upgrade path: move onto a durable queue.)
 */
export function learnAfterTurn(opts: {
  agentId: string
  endUserId: string
  userMessageId: string
  userMessage: string
  assistantMessage: string
  questionEmbedding: number[]
  model?: string
}): void {
  void (async () => {
    // Topic clustering (reuses the query embedding we already computed).
    try {
      await classifyQuestion({
        agentId: opts.agentId,
        messageId: opts.userMessageId,
        question: opts.userMessage,
        embedding: opts.questionEmbedding,
        model: opts.model,
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
        model: opts.model,
      })
    } catch (err) {
      console.error('[learn] memory extraction failed', err)
    }
  })()
}
