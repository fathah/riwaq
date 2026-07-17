import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  real,
  jsonb,
  timestamp,
  vector,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { env } from '../env'

// Embedding dimension — comes from EMBEDDING_DIM and must match the embedding
// model. Locked into the columns at first migration; changing it requires a
// re-embed. Never mix dimensions in one DB.
export const EMBEDDING_DIM = env.EMBEDDING_DIM

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // Auth: only a SHA-256 hash of the API key is stored (never the raw key). The
  // prefix is a non-secret display aid ("riwaq_1a2b…"). Raw key shown once, at creation.
  apiKeyHash: text('api_key_hash').notNull().unique(),
  apiKeyPrefix: text('api_key_prefix'),
  // Per-org LLM overrides. Each is nullable → falls back to the .env default.
  llmProvider: text('llm_provider'), // 'anthropic' | 'openai'
  llmBaseUrl: text('llm_base_url'), // OpenAI-compatible base URL
  llmApiKey: text('llm_api_key'), // key for the org's chosen provider/endpoint
  llmApiKeyEncrypted: boolean('llm_api_key_encrypted').notNull().default(false),
  llmModel: text('llm_model'),
  // Self-learning: auto-promote a learned answer once this many DISTINCT end users
  // endorse it. 0 = operator approval only.
  learnedAutoPromoteThreshold: integer('learned_auto_promote_threshold').notNull().default(0),
  // Webhook the reminder scheduler posts fired reminders to (signed with the secret).
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  webhookSecretEncrypted: boolean('webhook_secret_encrypted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull().default(''),
  // Optional per-agent overrides of the org's LLM config. Null → inherit from org/.env.
  provider: text('provider'), // 'anthropic' | 'openai'
  model: text('model'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const knowledgeBases = pgTable('knowledge_bases', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // true = the private KB auto-created for a single agent.
  isDefault: boolean('is_default').notNull().default(false),
  // Owner of a private KB (null for shared KBs). DB constraints enforce exactly
  // one private KB per agent and that private ⇔ owner-present. See 0003.
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// M:N link between agents and the KBs they can read. `orgId` is carried and
// tied to both sides by composite FKs (see 0004), so a cross-org link is
// impossible at the database level, not just discouraged by route guards.
export const agentKnowledgeBases = pgTable(
  'agent_knowledge_bases',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    knowledgeBaseId: uuid('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.knowledgeBaseId] })],
)

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  knowledgeBaseId: uuid('knowledge_base_id')
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  source: text('source').notNull().default('text'), // 'file' | 'text'
  status: text('status').notNull().default('processing'), // processing | ready | error
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  // Scoped to a KB, NOT to an agent — agents reach chunks via agent_knowledge_bases.
  knowledgeBaseId: uuid('knowledge_base_id')
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  endUserId: text('end_user_id').notNull(),
  summary: text('summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant
  content: text('content').notNull(),
  usedChunkIds: uuid('used_chunk_ids').array().notNull().default([]),
  feedback: text('feedback'), // null | up | down
  tokens: integer('tokens').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Reusable inbound/outbound messaging connections. Telegram is the first
// provider; future adapters (WhatsApp, Messenger, etc.) attach to the same agent
// and canonical chat pipeline without adding provider-specific columns.
export const agentChannels = pgTable(
  'agent_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    provider: text('provider').notNull(), // telegram | whatsapp | ...
    displayName: text('display_name').notNull(),
    externalId: text('external_id').notNull(),
    externalUsername: text('external_username'),
    credential: text('credential').notNull(),
    credentialEncrypted: boolean('credential_encrypted').notNull().default(false),
    webhookSecretHash: text('webhook_secret_hash').notNull(),
    status: text('status').notNull().default('connecting'), // connecting | active | error
    lastError: text('last_error'),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_agent_channels_agent_provider').on(t.agentId, t.provider),
    uniqueIndex('uq_agent_channels_provider_external').on(t.provider, t.externalId),
    index('idx_agent_channels_org').on(t.orgId),
  ],
)

// Maps a provider chat/user pair to one canonical Riwaq conversation. Including
// the external user prevents participants in a group chat from sharing history.
export const channelSessions = pgTable(
  'channel_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => agentChannels.id, { onDelete: 'cascade' }),
    externalChatId: text('external_chat_id').notNull(),
    externalUserId: text('external_user_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_channel_sessions_identity').on(t.channelId, t.externalChatId, t.externalUserId),
    uniqueIndex('uq_channel_sessions_conversation').on(t.conversationId),
  ],
)

// Telegram retries webhook deliveries. Provider event IDs make intake
// idempotent; responseText + sentPartCount let a retried worker resume delivery
// without running the agent twice or repeating already-sent message parts.
export const channelEvents = pgTable(
  'channel_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => agentChannels.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'), // pending | processing | responding | processed | error
    responseText: text('response_text'),
    sentPartCount: integer('sent_part_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_channel_events_provider_id').on(t.channelId, t.providerEventId),
    index('idx_channel_events_status').on(t.status, t.createdAt),
  ],
)

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  endUserId: text('end_user_id'), // nullable: agent-wide vs per-end-user fact
  fact: text('fact').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const topics = pgTable('topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  centroid: vector('centroid', { dimensions: EMBEDDING_DIM }).notNull(),
  count: integer('count').notNull().default(0),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
})

export const questionLogs = pgTable('question_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  // Best retrieval similarity at answer time — low ⇒ a likely knowledge gap.
  topSimilarity: real('top_similarity').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Self-learning: a Q&A the agent's own users endorsed. Clustered by question
// embedding so equivalent questions accrue endorsements to ONE candidate. On
// promotion the Q&A is written into the agent's KB (promotedDocumentId).
export const learnedAnswers = pgTable('learned_answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  distinctUserCount: integer('distinct_user_count').notNull().default(0),
  promotedDocumentId: uuid('promoted_document_id').references(() => documents.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// One endorsement per (candidate, end user). The composite PK is what makes
// distinctUserCount trustworthy: a single user cannot vote twice.
export const learnedAnswerVotes = pgTable(
  'learned_answer_votes',
  {
    learnedAnswerId: uuid('learned_answer_id')
      .notNull()
      .references(() => learnedAnswers.id, { onDelete: 'cascade' }),
    endUserId: text('end_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.learnedAnswerId, t.endUserId] })],
)

// Scheduled reminders. The scheduler polls next_fire_at and fires a signed webhook;
// recurring reminders advance, one-offs complete.
export const reminders = pgTable('reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  endUserId: text('end_user_id'),
  title: text('title').notNull(),
  message: text('message'), // static body, OR
  prompt: text('prompt'), // agent composes at fire time
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  recurrence: text('recurrence'), // null | daily | weekly | monthly | yearly
  status: text('status').notNull().default('scheduled'),
  source: text('source').notNull().default('api'), // api | auto
  nextFireAt: timestamp('next_fire_at', { withTimezone: true }).notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  fireCount: integer('fire_count').notNull().default(0),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const reminderDeliveries = pgTable('reminder_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  reminderId: uuid('reminder_id')
    .notNull()
    .references(() => reminders.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // ok | failed | skipped
  responseCode: integer('response_code'),
  error: text('error'),
  message: text('message'),
  firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
})

export const organizationUsage = pgTable('organization_usage', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // bigint (mode: number) so lifetime counters can't overflow int4 mid-turn.
  chatRequests: bigint('chat_requests', { mode: 'number' }).notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  estimatedCostMicros: bigint('estimated_cost_micros', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
