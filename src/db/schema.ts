import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  vector,
  primaryKey,
} from 'drizzle-orm/pg-core'

// Embedding dimension — locked to Voyage voyage-3. Changing this requires a
// full re-embed and a new migration; never mix dimensions in one DB.
export const EMBEDDING_DIM = 1024

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull().default(''),
  model: text('model').notNull().default('claude-haiku-4-5-20251001'),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// M:N link between agents and the KBs they can read.
export const agentKnowledgeBases = pgTable(
  'agent_knowledge_bases',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    knowledgeBaseId: uuid('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
