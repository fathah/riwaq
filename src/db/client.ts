import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'
import * as schema from './schema'

// Single shared connection pool for the app. Notices (e.g. "already exists,
// skipping" from idempotent migrations) are swallowed to keep boot logs clean.
// A server-side statement_timeout keeps one runaway query (e.g. a pathological
// vector scan) from pinning a pooled connection; connect/idle timeouts reap dead
// peers so the pool self-heals instead of leaking connections.
export const sql = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  connect_timeout: 10,
  idle_timeout: 30,
  onnotice: () => {},
  connection: {
    ...(env.DB_STATEMENT_TIMEOUT_MS > 0 ? { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS } : {}),
  },
})

export const db = drizzle(sql, { schema })
