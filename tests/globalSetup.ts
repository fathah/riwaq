import postgres from 'postgres'

// Create a clean `riwaq_test` database before the suite and drop it after. We
// connect to the maintenance `postgres` database to issue CREATE/DROP DATABASE.
const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgres://fathah@localhost:5432/riwaq_test'

function adminUrlAndName(url: string): { adminUrl: string; dbName: string } {
  const u = new URL(url)
  const dbName = u.pathname.replace(/^\//, '')
  u.pathname = '/postgres'
  return { adminUrl: u.toString(), dbName }
}

export async function setup() {
  const { adminUrl, dbName } = adminUrlAndName(TEST_DB_URL)
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    // Terminate stragglers, then recreate for a pristine schema each run.
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`)
    await admin.unsafe(`CREATE DATABASE ${dbName}`)
  } finally {
    await admin.end()
  }
}

export async function teardown() {
  const { adminUrl, dbName } = adminUrlAndName(TEST_DB_URL)
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`)
  } finally {
    await admin.end()
  }
}
