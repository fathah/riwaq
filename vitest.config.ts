import { defineConfig } from 'vitest/config'

// Tests run against a throwaway `riwaq_test` database (created in globalSetup).
// A tiny EMBEDDING_DIM keeps hand-written vectors small; keys are dummies since
// no test hits a real LLM/embedding provider.
const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://fathah@localhost:5432/riwaq_test'

export default defineConfig({
  test: {
    globalSetup: './tests/globalSetup.ts',
    // DB isolation tests share one database — don't run test files in parallel.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DB,
      NODE_ENV: 'test',
      EMBEDDING_DIM: '8',
      ANTHROPIC_API_KEY: 'test-key',
      LLM_ALLOWED_HOSTS: '',
    },
  },
})
