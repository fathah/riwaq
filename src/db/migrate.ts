import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from './client'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, 'migrations')

// Applies every .sql file in migrations/ in lexical order. Each file is written
// to be idempotent (IF NOT EXISTS), so re-running on boot is safe.
export async function migrate() {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const ddl = await readFile(join(migrationsDir, file), 'utf-8')
    await sql.unsafe(ddl)
    console.log(`[migrate] applied ${file}`)
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
