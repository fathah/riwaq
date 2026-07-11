import { describe, expect, it } from 'vitest'
import { app } from '../src/index'

describe('OpenAPI contract', () => {
  it('serves a versioned 3.1 document for both chat surfaces', async () => {
    const response = await app.request('/openapi.json')
    expect(response.status).toBe(200)
    const spec = await response.json() as { openapi: string; info: { version: string }; paths: Record<string, unknown> }
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.version).toBe('1.0.0')
    expect(spec.paths['/agents/{id}/chat']).toBeDefined()
    expect(spec.paths['/v1/chat/completions']).toBeDefined()
  })
})
