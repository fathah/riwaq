import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'
import * as schema from './schema'

// Single shared connection pool for the app. Notices (e.g. "already exists,
// skipping" from idempotent migrations) are swallowed to keep boot logs clean.
export const sql = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} })

export const db = drizzle(sql, { schema })
