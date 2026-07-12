import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().url(),

  // LLM providers. An agent picks one via its `provider` field. Keys are optional
  // at boot so CRUD works without them; call sites throw a clear error if missing.
  ANTHROPIC_API_KEY: z.string().default(''),

  // OpenAI-compatible endpoint — works for OpenAI, OpenRouter, Groq, Together,
  // local Ollama/vLLM/LM Studio, etc. Just point OPENAI_BASE_URL at the server.
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

  // Deployment-wide defaults, used when an org (and agent) don't override them.
  LLM_DEFAULT_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  LLM_DEFAULT_MODEL: z.string().default(''), // empty → fall back to the provider's built-in default

  // --- Embeddings (pluggable, with an offline fallback) ---
  // Provider: 'voyage' | 'openai' (any /v1/embeddings server) | 'local' (in-process,
  // offline, no key). If unset: 'voyage' when EMBEDDINGS_API_KEY is set, else 'local'.
  EMBEDDINGS_PROVIDER: z.enum(['voyage', 'openai', 'local']).optional(),
  EMBEDDINGS_API_KEY: z.string().default(''),
  EMBEDDINGS_BASE_URL: z.string().url().default('https://api.openai.com/v1'), // for 'openai'
  EMBEDDINGS_MODEL: z.string().default(''), // empty → provider's default model
  // Vector dimension. MUST match the embedding model. Locked into the DB columns at
  // first migration — changing it later requires re-creating vectors.
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),

  // --- Safety / limits ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // SSRF: optional allowlist of hostnames a tenant may use for LLM/embedding
  // egress (comma-separated). Empty → any public host allowed (private/reserved
  // IPs are always blocked). Set this in production to lock egress to known providers.
  LLM_ALLOWED_HOSTS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
  // Permit http:// (not just https) for tenant LLM URLs — local dev only.
  ALLOW_INSECURE_LLM_URLS: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  // Base64-encoded 32-byte master key for tenant LLM credentials (AES-256-GCM).
  // Optional in development; mandatory in production.
  SECRET_ENCRYPTION_KEY: z.string().default(''),
  // HMAC key used by trusted organization backends to sign end-user identity.
  // Base64-encoded 32+ bytes; mandatory in production.
  END_USER_SIGNING_SECRET: z.string().default(''),
  // Bound cached provider clients so rotated credentials leave memory promptly.
  LLM_CLIENT_CACHE_MAX: z.coerce.number().int().positive().default(100),
  LLM_CLIENT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // --- DragonflyDB / Redis (optional; enables durable jobs, caching, rate limits) ---
  // Redis-protocol URL (DragonflyDB is a drop-in). Empty → all Redis-backed features
  // degrade gracefully: jobs run in-process, caching is skipped, rate limiting uses
  // an in-process fallback. So the app still runs with zero extra services.
  REDIS_URL: z.string().default(''),
  // TTL (seconds) for cached org-auth + resolved LLM-config lookups.
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),

  // --- Abuse controls ---
  // If set, POST /organizations requires this bootstrap token (admin-gated signup).
  // Empty → open signup (dev), still rate-limited.
  ADMIN_TOKEN: z.string().default(''),
  // Fixed-window rate limits. Per authenticated org, and a tighter per-IP limit on
  // the public org-creation endpoint.
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_PER_ORG: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_SIGNUP_PER_IP: z.coerce.number().int().positive().default(5),
  MAX_CONCURRENT_REQUESTS_PER_ORG: z.coerce.number().int().positive().default(20),
  ORG_MAX_TOTAL_TOKENS: z.coerce.number().int().nonnegative().default(10_000_000),
  ORG_MAX_ESTIMATED_COST_MICROS: z.coerce.number().int().nonnegative().default(100_000_000),
  ORG_MAX_DOCUMENTS: z.coerce.number().int().positive().default(10_000),
  ORG_MAX_STORED_CHARS: z.coerce.number().int().positive().default(100_000_000),
  COST_PER_MILLION_INPUT_TOKENS_MICROS: z.coerce.number().int().nonnegative().default(0),
  COST_PER_MILLION_OUTPUT_TOKENS_MICROS: z.coerce.number().int().nonnegative().default(0),
  // Max accepted request body size in bytes (protects parsing + memory). Must stay
  // above the document upload cap (15 MB, see routes/documents.ts) or file uploads
  // would be rejected at the global boundary before reaching that route. Default 20 MB.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // --- Retrieval tuning ---
  // Drop retrieved chunks below this cosine similarity (0..1). 0 = keep all.
  // A small floor stops clearly-irrelevant chunks being surfaced as "citations"
  // for off-topic questions. Calibrate per embedding model.
  RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.2),
  // Cap total characters of retrieved context injected into the prompt (token budget guard).
  RETRIEVAL_CHAR_BUDGET: z.coerce.number().int().positive().default(12_000),
  // HNSW candidate-list size for ANN search. Higher = better recall (esp. for the
  // KB-filtered case) at some latency cost. pgvector default is 40; we raise it so
  // per-tenant filters don't starve the candidate set.
  RETRIEVAL_HNSW_EF_SEARCH: z.coerce.number().int().positive().default(100),
  // A question at least this cosine-similar to a topic centroid joins that cluster.
  TOPIC_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  // Chunking. Defaults are sized to fit the shipped local embedder
  // (all-MiniLM-L6-v2, ~256-token cap ≈ 1000 chars) so no chunk is silently
  // truncated at embed time. Raise these for long-context embedders (Voyage/OpenAI).
  CHUNK_MAX_CHARS: z.coerce.number().int().positive().default(1000),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().nonnegative().default(150),
  // Cap total characters of prior-turn history injected into a prompt (token guard;
  // applies to DB history and client-supplied OpenAI history alike).
  HISTORY_CHAR_BUDGET: z.coerce.number().int().positive().default(8_000),
  // Bound long-term memory rows per (agent, end user) so memory can't grow forever.
  MEMORY_MAX_PER_USER: z.coerce.number().int().positive().default(500),

  // --- Self-learning ---
  // An up-voted question this cosine-similar to an existing learned-answer
  // candidate is treated as the SAME question (endorsements accrue to one row).
  LEARNED_DEDUP_SIMILARITY: z.coerce.number().min(0).max(1).default(0.9),
  // A question whose best retrieved chunk was below this similarity is counted as a
  // knowledge gap in the learning report.
  LEARNING_GAP_SIMILARITY: z.coerce.number().min(0).max(1).default(0.25),

  // --- Reminders / scheduler ---
  // Run the due-reminder poller in this process. Disable on nodes that should not
  // fire reminders (e.g. a dedicated worker split later).
  REMINDER_SCHEDULER_ENABLED: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  REMINDER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  REMINDER_BATCH: z.coerce.number().int().positive().default(50),
  REMINDER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  REMINDER_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Auto-create reminders from dated commitments the LLM detects in conversations.
  // Adds one cheap LLM call per chat turn — set to 0 to disable.
  REMINDER_AUTO_EXTRACT: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  // Guardrails for auto-extracted reminders: bound how far out and how many per user.
  REMINDER_MAX_HORIZON_DAYS: z.coerce.number().int().positive().default(1825), // ~5y
  REMINDER_MAX_PER_USER: z.coerce.number().int().positive().default(100),

  // --- Database pool ---
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Server-side statement timeout (ms). Stops a runaway query from pinning a pooled
  // connection. 0 disables. Kept comfortably above normal chat/ingest query time.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

  PORT: z.coerce.number().default(3000),
}).superRefine((value, ctx) => {
  if (value.SECRET_ENCRYPTION_KEY) {
    const decoded = Buffer.from(value.SECRET_ENCRYPTION_KEY, 'base64')
    const canonical = decoded.toString('base64').replace(/=+$/, '')
    const supplied = value.SECRET_ENCRYPTION_KEY.replace(/=+$/, '')
    if (decoded.length !== 32 || canonical !== supplied) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRET_ENCRYPTION_KEY'],
        message: 'must be a canonical base64-encoded 32-byte key',
      })
    }
  }
  if (value.NODE_ENV === 'production' && !value.SECRET_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SECRET_ENCRYPTION_KEY'],
      message: 'is required in production',
    })
  }
  if (value.END_USER_SIGNING_SECRET && Buffer.from(value.END_USER_SIGNING_SECRET, 'base64').length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['END_USER_SIGNING_SECRET'],
      message: 'must be base64-encoded and decode to at least 32 bytes',
    })
  }
  if (value.NODE_ENV === 'production' && !value.END_USER_SIGNING_SECRET) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['END_USER_SIGNING_SECRET'], message: 'is required in production' })
  }
  if (value.NODE_ENV === 'production' && value.LLM_ALLOWED_HOSTS.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['LLM_ALLOWED_HOSTS'], message: 'must not be empty in production' })
  }
  if (value.NODE_ENV === 'production' && !value.REDIS_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['REDIS_URL'], message: 'is required in production' })
  }
  if (value.NODE_ENV === 'production' && !value.ADMIN_TOKEN) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ADMIN_TOKEN'], message: 'is required in production' })
  }
})

export const env = schema.parse(process.env)

export const isProd = env.NODE_ENV === 'production'
