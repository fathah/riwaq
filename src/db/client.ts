import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'
import * as schema from './schema'

// Single shared connection pool for the app.
export const sql = postgres(env.DATABASE_URL, { max: 10 })

export const db = drizzle(sql, { schema })
