import { describe, expect, it } from 'vitest'
import { app } from '../src/index'

describe('OpenAPI contract', () => {
  it('serves a versioned 3.1 document covering the full surface', async () => {
    const response = await app.request('/openapi.json')
    expect(response.status).toBe(200)
    const spec = (await response.json()) as {
      openapi: string
      info: { version: string }
      paths: Record<string, unknown>
    }
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.version).toBe('1.1.0')

    // Chat surfaces (native + OpenAI-compatible).
    expect(spec.paths['/agents/{id}/chat']).toBeDefined()
    expect(spec.paths['/v1/chat/completions']).toBeDefined()

    // Self-learning + reminders must be documented.
    for (const path of [
      '/organizations/learning',
      '/organizations/webhook',
      '/agents/{id}/analytics/learning',
      '/agents/{id}/learned-answers',
      '/agents/{id}/reminders',
      '/agents/{id}/reminders/{rid}',
    ]) {
      expect(spec.paths[path], `missing ${path}`).toBeDefined()
    }
  })
})
