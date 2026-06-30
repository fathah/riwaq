import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().url(),
  // Optional at boot so the server can run CRUD-only flows without LLM keys.
  // Call sites (embeddings / llm) throw a clear error if these are empty.
  ANTHROPIC_API_KEY: z.string().default(''),
  EMBEDDINGS_API_KEY: z.string().default(''),
  PORT: z.coerce.number().default(3000),
})

export const env = schema.parse(process.env)
