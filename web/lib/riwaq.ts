import { requireDashboardConfig } from './config'

export type Organization = {
  id: string
  name: string
  createdAt: string
  llm: { provider: string | null; baseUrl: string | null; model: string | null; hasApiKey: boolean }
}

export type UsageSnapshot = {
  usage: {
    chatRequests: number
    inputTokens: number
    outputTokens: number
    estimatedCostMicros: number
    documents: number
    storedChars: number
    updatedAt: string | null
  }
  limits: {
    totalTokens: number
    estimatedCostMicros: number
    documents: number
    storedChars: number
  }
}

export type Agent = {
  id: string
  name: string
  systemPrompt: string
  provider: string | null
  model: string | null
  createdAt: string
}

export type KnowledgeBase = {
  id: string
  name: string
  isDefault: boolean
  agentId: string | null
  createdAt: string
}

export class RiwaqApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiUrl, apiKey } = requireDashboardConfig()
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${apiKey}`)
  headers.set('accept', 'application/json')
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')

  const response = await fetch(new URL(path, `${apiUrl}/`), {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `Riwaq API returned ${response.status}`
    throw new RiwaqApiError(message, response.status)
  }
  return payload as T
}

export async function getDashboardData() {
  const [ready, organization, usage, agents, knowledgeBases] = await Promise.all([
    request<{ ready: boolean }>('/ready'),
    request<Organization>('/organizations/me'),
    request<UsageSnapshot>('/organizations/usage'),
    request<Agent[]>('/agents?limit=200'),
    request<KnowledgeBase[]>('/knowledge-bases?limit=200'),
  ])
  return { ready, organization, usage, agents, knowledgeBases }
}

export function createAgent(input: { name: string; systemPrompt?: string; provider?: string; model?: string }) {
  return request('/agents', { method: 'POST', body: JSON.stringify(input) })
}

export function createKnowledgeBase(name: string) {
  return request('/knowledge-bases', { method: 'POST', body: JSON.stringify({ name }) })
}

export function updateOrganizationLlm(input: Record<string, string>) {
  return request('/organizations/llm', { method: 'PUT', body: JSON.stringify(input) })
}
