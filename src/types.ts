// Shared Hono environment type. `orgId` is set by the org-auth middleware
// after resolving the request's API key, and every protected route reads it.
export type AppEnv = {
  Variables: {
    orgId: string
    requestId: string
  }
}
