import { and, count, cosineDistance, desc, eq, lt, ne, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  documents,
  knowledgeBases,
  learnedAnswers,
  learnedAnswerVotes,
  organizations,
  questionLogs,
  topics,
} from '../db/schema'
import { embed } from '../lib/embeddings'
import { enqueueIngest } from '../lib/queue'
import { env } from '../env'

// ---------------------------------------------------------------------------
// Per-org self-learning: turn end-user endorsements into vetted knowledge.
//
// Flow: an up-voted answer → cluster its question with equivalent past questions
// into ONE candidate → count DISTINCT endorsing users → promote (auto once the
// org's threshold is met, else on operator approval). Promotion writes the Q&A
// into the agent's own knowledge base, so future retrieval surfaces it.
//
// Everything here is org/agent-scoped. End-user feedback is untrusted, so a
// candidate only becomes knowledge via the distinct-user threshold or an operator.
// ---------------------------------------------------------------------------

export type UpvoteInput = {
  orgId: string
  agentId: string
  endUserId: string
  question: string
  answer: string
}

/**
 * Record one end-user endorsement of a Q&A and promote it if the org's
 * distinct-user threshold is met. Best-effort and self-contained: callers
 * fire-and-forget, so this never throws into the request path.
 */
export async function captureUpvote(input: UpvoteInput): Promise<void> {
  try {
    const [embedding] = await embed([input.question], 'document')
    if (!embedding) return

    const { candidateId, promote } = await db.transaction(async (tx) => {
      // Serialize candidate creation per agent so two near-simultaneous first
      // endorsements of the same question can't create duplicate candidates.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'learned:' + input.agentId}))`)

      const distance = cosineDistance(learnedAnswers.embedding, embedding)
      const [nearest] = await tx
        .select({ id: learnedAnswers.id, status: learnedAnswers.status, similarity: sql<number>`1 - (${distance})` })
        .from(learnedAnswers)
        .where(and(eq(learnedAnswers.agentId, input.agentId), ne(learnedAnswers.status, 'rejected')))
        .orderBy(distance)
        .limit(1)

      let candidateId: string
      let status: string
      if (nearest && nearest.similarity >= env.LEARNED_DEDUP_SIMILARITY) {
        candidateId = nearest.id
        status = nearest.status
      } else {
        const [created] = await tx
          .insert(learnedAnswers)
          .values({
            orgId: input.orgId,
            agentId: input.agentId,
            question: input.question,
            answer: input.answer,
            embedding,
          })
          .returning({ id: learnedAnswers.id })
        candidateId = created!.id
        status = 'pending'
      }

      // One endorsement per end user (composite PK). A repeat vote is a no-op.
      const voted = await tx
        .insert(learnedAnswerVotes)
        .values({ learnedAnswerId: candidateId, endUserId: input.endUserId })
        .onConflictDoNothing()
        .returning({ endUserId: learnedAnswerVotes.endUserId })

      let distinctUsers: number
      if (voted.length > 0) {
        const [tally] = await tx
          .select({ n: count() })
          .from(learnedAnswerVotes)
          .where(eq(learnedAnswerVotes.learnedAnswerId, candidateId))
        distinctUsers = Number(tally?.n ?? 0)
        await tx
          .update(learnedAnswers)
          .set({ distinctUserCount: distinctUsers, updatedAt: new Date() })
          .where(eq(learnedAnswers.id, candidateId))
      } else {
        const [row] = await tx
          .select({ n: learnedAnswers.distinctUserCount })
          .from(learnedAnswers)
          .where(eq(learnedAnswers.id, candidateId))
        distinctUsers = row?.n ?? 0
      }

      const [org] = await tx
        .select({ threshold: organizations.learnedAutoPromoteThreshold })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
      const threshold = org?.threshold ?? 0
      const promote = status === 'pending' && threshold > 0 && distinctUsers >= threshold
      return { candidateId, promote }
    })

    if (promote) await promoteLearnedAnswer(candidateId)
  } catch (err) {
    console.error('[learning] captureUpvote failed', err)
  }
}

/**
 * Promote a pending candidate: mark it approved and write the Q&A into the agent's
 * private KB as a document (async-ingested → chunked → embedded → retrievable).
 * Claims the row atomically so concurrent auto+operator promotion runs once.
 */
export async function promoteLearnedAnswer(learnedAnswerId: string): Promise<'promoted' | 'noop'> {
  const [claimed] = await db
    .update(learnedAnswers)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(and(eq(learnedAnswers.id, learnedAnswerId), eq(learnedAnswers.status, 'pending')))
    .returning({
      agentId: learnedAnswers.agentId,
      question: learnedAnswers.question,
      answer: learnedAnswers.answer,
    })
  if (!claimed) return 'noop' // already approved/rejected

  const [kb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.agentId, claimed.agentId), eq(knowledgeBases.isDefault, true)))
    .limit(1)
  if (!kb) return 'noop'

  const name = `Learned: ${claimed.question}`.slice(0, 300)
  const [doc] = await db
    .insert(documents)
    .values({ knowledgeBaseId: kb.id, name, source: 'learned', status: 'processing' })
    .returning({ id: documents.id })
  await db.update(learnedAnswers).set({ promotedDocumentId: doc!.id }).where(eq(learnedAnswers.id, learnedAnswerId))

  await enqueueIngest({
    documentId: doc!.id,
    knowledgeBaseId: kb.id,
    text: `Q: ${claimed.question}\nA: ${claimed.answer}`,
  })
  return 'promoted'
}

/** Operator approval: promote a specific pending candidate owned by this agent. */
export async function approveLearnedAnswer(agentId: string, learnedAnswerId: string): Promise<'promoted' | 'noop'> {
  const [row] = await db
    .select({ id: learnedAnswers.id })
    .from(learnedAnswers)
    .where(and(eq(learnedAnswers.id, learnedAnswerId), eq(learnedAnswers.agentId, agentId), eq(learnedAnswers.status, 'pending')))
    .limit(1)
  if (!row) return 'noop'
  return promoteLearnedAnswer(learnedAnswerId)
}

/** Operator rejection: a rejected candidate is never re-clustered or promoted. */
export async function rejectLearnedAnswer(agentId: string, learnedAnswerId: string): Promise<boolean> {
  const rejected = await db
    .update(learnedAnswers)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(and(eq(learnedAnswers.id, learnedAnswerId), eq(learnedAnswers.agentId, agentId), eq(learnedAnswers.status, 'pending')))
    .returning({ id: learnedAnswers.id })
  return rejected.length > 0
}

export async function listLearnedAnswers(agentId: string, status: string | undefined, limit: number, offset: number) {
  const where = status
    ? and(eq(learnedAnswers.agentId, agentId), eq(learnedAnswers.status, status))
    : eq(learnedAnswers.agentId, agentId)
  return db
    .select({
      id: learnedAnswers.id,
      question: learnedAnswers.question,
      answer: learnedAnswers.answer,
      status: learnedAnswers.status,
      distinctUserCount: learnedAnswers.distinctUserCount,
      promotedDocumentId: learnedAnswers.promotedDocumentId,
      createdAt: learnedAnswers.createdAt,
      updatedAt: learnedAnswers.updatedAt,
    })
    .from(learnedAnswers)
    .where(where)
    .orderBy(desc(learnedAnswers.distinctUserCount), desc(learnedAnswers.updatedAt))
    .limit(limit)
    .offset(offset)
}

/**
 * The learning report: what the agent can't yet answer (knowledge gaps, ranked by
 * how often they're asked), overall answer coverage, and the learned-answer
 * pipeline state. Powers "what should we teach this agent next".
 */
export async function getLearningReport(agentId: string) {
  const floor = env.LEARNING_GAP_SIMILARITY

  const [[coverage], gapTopics, statusRows] = await Promise.all([
    db
      .select({
        total: count(),
        gaps: sql<number>`count(*) filter (where ${questionLogs.topSimilarity} < ${floor})`,
      })
      .from(questionLogs)
      .where(eq(questionLogs.agentId, agentId)),
    db
      .select({
        topic: topics.label,
        unanswered: count(),
        avgSimilarity: sql<number>`avg(${questionLogs.topSimilarity})`,
      })
      .from(questionLogs)
      .innerJoin(topics, eq(topics.id, questionLogs.topicId))
      .where(and(eq(questionLogs.agentId, agentId), lt(questionLogs.topSimilarity, floor)))
      .groupBy(topics.label)
      .orderBy(desc(count()))
      .limit(20),
    db
      .select({ status: learnedAnswers.status, n: count() })
      .from(learnedAnswers)
      .where(eq(learnedAnswers.agentId, agentId))
      .groupBy(learnedAnswers.status),
  ])

  const total = Number(coverage?.total ?? 0)
  const gaps = Number(coverage?.gaps ?? 0)
  const learned = { pending: 0, approved: 0, rejected: 0 }
  for (const r of statusRows) if (r.status in learned) learned[r.status as keyof typeof learned] = Number(r.n)

  return {
    coverage: {
      totalQuestions: total,
      answered: total - gaps,
      unanswered: gaps,
      answerRate: total > 0 ? Number(((total - gaps) / total).toFixed(4)) : null,
    },
    gaps: gapTopics.map((g) => ({
      topic: g.topic,
      count: Number(g.unanswered),
      avgSimilarity: g.avgSimilarity === null ? 0 : Number(Number(g.avgSimilarity).toFixed(4)),
    })),
    learned,
  }
}
