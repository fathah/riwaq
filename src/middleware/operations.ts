import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

const startedAt = Date.now()
let requests = 0
let errors = 0
let active = 0

export const operations = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('x-request-id')?.slice(0, 128) || randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  const start = performance.now()
  requests++
  active++
  try {
    await next()
    if (c.res.status >= 500) errors++
  } catch (err) {
    errors++
    throw err
  } finally {
    active--
    console.log(JSON.stringify({
      level: 'info', event: 'request', requestId, method: c.req.method,
      path: new URL(c.req.url).pathname, status: c.res.status,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    }))
  }
})

export function operationalMetrics(): string {
  return [
    '# TYPE riwaq_http_requests_total counter',
    `riwaq_http_requests_total ${requests}`,
    '# TYPE riwaq_http_errors_total counter',
    `riwaq_http_errors_total ${errors}`,
    '# TYPE riwaq_http_requests_active gauge',
    `riwaq_http_requests_active ${active}`,
    '# TYPE riwaq_process_uptime_seconds gauge',
    `riwaq_process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    '',
  ].join('\n')
}
