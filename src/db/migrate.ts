import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { sql } from './client'
import { env } from '../env'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, 'migrations')

// A constant key for a Postgres advisory lock. Serializes migration runs so that
// several API replicas booting at once can't apply the same DDL concurrently.
const MIGRATION_LOCK_KEY = 40_719_2026 // arbitrary but fixed

/**
 * Ledgered, locked migration runner. Each `*.sql` file is applied exactly once,
 * inside a transaction, and recorded in `schema_migrations` with a checksum. A
 * file whose contents changed after being applied is a hard error — history is
 * immutable; write a new forward migration instead of editing an old one.
 */
export async function migrate() {
  // Session-level advisory lock for the whole run (released in finally).
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `

    const rows = await sql<{ filename: string; checksum: string }[]>`
      SELECT filename, checksum FROM schema_migrations
    `
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]))

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      const raw = await readFile(join(migrationsDir, file), 'utf-8')
      // Vector columns are templated so the dimension follows EMBEDDING_DIM.
      const ddl = raw.replaceAll('__EMBED_DIM__', String(env.EMBEDDING_DIM))
      const checksum = createHash('sha256').update(ddl).digest('hex')

      const prior = applied.get(file)
      if (prior) {
        if (prior !== checksum) {
          throw new Error(
            `[migrate] ${file} was already applied with a different checksum — migrations are immutable. ` +
              `Add a new forward migration instead of editing ${file}.`,
          )
        }
        continue
      }

      // Apply the whole file atomically, then record it in the same transaction.
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl)
        await tx`INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})`
      })
      console.log(`[migrate] applied ${file}`)
    }
    console.log('[migrate] up to date')
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`
  }
}

// Allow running standalone: `npm run migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      console.log('[migrate] done')
      return sql.end()
    })
    .catch((err) => {
      console.error('[migrate] failed', err)
      process.exit(1)
    })
}
