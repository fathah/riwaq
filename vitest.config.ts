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
      SECRET_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      END_USER_SIGNING_SECRET: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      LLM_ALLOWED_HOSTS: '',
      // The suite creates many orgs/requests from one "IP"; don't rate-limit tests.
      RATE_LIMIT_PER_ORG: '1000000',
      RATE_LIMIT_SIGNUP_PER_IP: '1000000',
    },
  },
})
