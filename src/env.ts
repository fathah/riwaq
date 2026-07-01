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
  // Max accepted request body size in bytes (protects parsing + memory). Default 10 MB.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  // --- Retrieval tuning ---
  // Drop retrieved chunks below this cosine similarity (0..1). 0 = keep all.
  // Calibrate per embedding model; left off by default so behavior never regresses.
  RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0),
  // Cap total characters of retrieved context injected into the prompt (token budget guard).
  RETRIEVAL_CHAR_BUDGET: z.coerce.number().int().positive().default(12_000),

  PORT: z.coerce.number().default(3000),
})

export const env = schema.parse(process.env)

export const isProd = env.NODE_ENV === 'production'
