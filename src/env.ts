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

  // Embeddings (Voyage). Required for ingest/chat.
  EMBEDDINGS_API_KEY: z.string().default(''),

  PORT: z.coerce.number().default(3000),
})

export const env = schema.parse(process.env)
