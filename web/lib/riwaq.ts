import { requireDashboardConfig } from './config'
import { getSelectedOrganizationId } from './auth'

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

export type AgentDetail = Agent & {
  knowledgeBases: Array<Pick<KnowledgeBase, 'id' | 'name' | 'isDefault'>>
  effectiveLlm: {
    provider: string
    model: string
    baseURL?: string
  }
}

export type AgentChannel = {
  id: string
  agentId: string
  provider: 'telegram' | string
  displayName: string
  externalUsername: string | null
  status: 'connecting' | 'active' | 'error'
  lastError: string | null
  lastReceivedAt: string | null
  createdAt: string
}

export type AgentMemory = {
  id: string
  endUserId: string | null
  fact: string
  updatedAt: string
}

export type EndUser = {
  id: string
  displayName: string | null
  identityCount: number
  memoryCount: number
  createdAt: string
  updatedAt: string
}

export type UserIdentity = {
  id: string
  provider: string
  namespace: string
  externalUserId: string
  createdAt: string
}

export type UserMemory = AgentMemory & {
  agentId: string
  agentName: string
  endUserId: string
}

export type EndUserDetail = { user: EndUser; identities: UserIdentity[] }

export type KnowledgeBase = {
  id: string
  name: string
  isDefault: boolean
  agentId: string | null
  createdAt: string
}

export type KnowledgeDocument = {
  id: string
  knowledgeBaseId: string
  name: string
  source: 'file' | 'text'
  status: 'processing' | 'ready' | 'error'
  createdAt: string
}

export type KnowledgeChunk = {
  id: string
  content: string
  metadata: { index?: number }
  createdAt: string
}

export type KnowledgeDocumentDetail = {
  document: KnowledgeDocument
  chunks: KnowledgeChunk[]
  page: { limit: number; offset: number; hasMore: boolean }
}

export type ManagedOrganization = {
  id: string
  name: string
  createdAt: string
  apiKeyPrefix: string | null
  llm: { provider: string | null; model: string | null }
}

export type ChatCitation = {
  chunkId: string
  documentId: string
  documentName: string
  knowledgeBaseId: string
  kbName: string
  similarity: number
}

export type ChatResult = {
  conversationId: string
  answer: string
  citations: ChatCitation[]
  model: string
  usage: { inputTokens: number; outputTokens: number }
  finishReason: string
}

export class RiwaqApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiUrl, apiKey, adminToken } = requireDashboardConfig()
  const headers = new Headers(init.headers)
  const selectedOrganizationId = adminToken ? await getSelectedOrganizationId() : null
  if (adminToken && selectedOrganizationId) {
    headers.set('x-admin-token', adminToken)
    headers.set('x-riwaq-organization-id', selectedOrganizationId)
  } else {
    headers.set('authorization', `Bearer ${apiKey}`)
  }
  headers.set('accept', 'application/json')
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json')

  const response = await fetch(new URL(path, `${apiUrl}/`), {
    ...init,
    headers,
    cache: 'no-store',
    signal: init.signal ?? AbortSignal.timeout(10_000),
  })
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `Riwaq API returned ${response.status}`
    throw new RiwaqApiError(message, response.status)
  }
  return payload as T
}

async function organizationAdminRequest<T>(organizationId: string, path: string, init: RequestInit): Promise<T> {
  const { apiUrl, adminToken } = requireDashboardConfig()
  if (!adminToken) return request<T>(path, init)
  const headers = new Headers(init.headers)
  headers.set('x-admin-token', adminToken)
  headers.set('x-riwaq-organization-id', organizationId)
  headers.set('accept', 'application/json')
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(new URL(path, `${apiUrl}/`), {
    ...init,
    headers,
    cache: 'no-store',
    signal: init.signal ?? AbortSignal.timeout(90_000),
  })
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `Riwaq API returned ${response.status}`
    throw new RiwaqApiError(message, response.status)
  }
  return payload as T
}

async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiUrl, adminToken } = requireDashboardConfig()
  if (!adminToken) throw new RiwaqApiError('Organization management requires RIWAQ_ADMIN_TOKEN', 403)
  const headers = new Headers(init.headers)
  headers.set('x-admin-token', adminToken)
  headers.set('accept', 'application/json')
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(new URL(path, `${apiUrl}/`), { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `Riwaq API returned ${response.status}`
    throw new RiwaqApiError(message, response.status)
  }
  return payload as T
}

export async function getReady() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request<{ ready: boolean }>('/ready')
    } catch (error) {
      if (!(error instanceof RiwaqApiError) || error.status !== 503 || attempt === 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  throw new Error('Riwaq API is not ready')
}

export function getOrganization() {
  return request<Organization>('/organizations/me')
}

export function getUsage() {
  return request<UsageSnapshot>('/organizations/usage')
}

export function getAgents() {
  return request<Agent[]>('/agents?limit=200')
}

export function getAgent(agentId: string) {
  return request<AgentDetail>(`/agents/${encodeURIComponent(agentId)}`)
}

export function getChannels() {
  return request<AgentChannel[]>('/channels')
}

export function getAgentChannels(agentId: string) {
  return request<AgentChannel[]>(`/agents/${encodeURIComponent(agentId)}/channels`)
}

export function getAgentMemories(agentId: string) {
  return request<AgentMemory[]>(`/agents/${encodeURIComponent(agentId)}/memories?limit=200`)
}

export function getUsers() {
  return request<EndUser[]>('/users?limit=200')
}

export function getUser(userId: string) {
  return request<EndUserDetail>(`/users/${encodeURIComponent(userId)}`)
}

export function getUserMemories(userId: string) {
  return request<UserMemory[]>(`/users/${encodeURIComponent(userId)}/memories?limit=200`)
}

export function connectUser(input: {
  userId: string
  displayName?: string
  provider?: string
  namespace?: string
  externalUserId?: string
  mergeExisting?: boolean
}) {
  return request<{ userId: string; identity: UserIdentity | null; mergedFrom: string | null }>('/users/connect', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateUser(userId: string, displayName: string | null) {
  return request<EndUser>(`/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  })
}

export function disconnectUserIdentity(userId: string, identityId: string) {
  return request<{ ok: true }>(`/users/${encodeURIComponent(userId)}/identities/${encodeURIComponent(identityId)}`, {
    method: 'DELETE',
  })
}

export function getKnowledgeBases() {
  return request<KnowledgeBase[]>('/knowledge-bases?limit=200')
}

export function getKnowledgeDocuments(knowledgeBaseId: string) {
  return request<KnowledgeDocument[]>(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents?limit=200`)
}

export function getKnowledgeDocument(knowledgeBaseId: string, documentId: string) {
  return request<KnowledgeDocumentDetail>(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}?limit=200`)
}

export function uploadKnowledgeDocument(knowledgeBaseId: string, input: FormData | { name: string; text: string }) {
  return request<{ documentId: string; name: string; status: string }>(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`, {
    method: 'POST',
    body: input instanceof FormData ? input : JSON.stringify(input),
    signal: AbortSignal.timeout(90_000),
  })
}

export function deleteKnowledgeDocument(knowledgeBaseId: string, documentId: string) {
  return request<{ ok: true }>(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' })
}

export async function chatWithAgent(agentId: string, input: { message: string; conversationId?: string }) {
  const selectedOrganizationId = await getSelectedOrganizationId()
  const organizationId = selectedOrganizationId ?? (await getOrganization()).id
  return organizationAdminRequest<ChatResult>(organizationId, `/agents/${encodeURIComponent(agentId)}/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      message: input.message,
      endUserId: 'riwaq-console-playground',
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    }),
  })
}

export function createAgent(input: { name: string; systemPrompt?: string; provider?: string; model?: string }) {
  return request('/agents', { method: 'POST', body: JSON.stringify(input) })
}

export function updateAgentInstructions(agentId: string, systemPrompt: string) {
  return request<Agent>(`/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ systemPrompt }),
  })
}

export function createAgentMemory(agentId: string, input: { fact: string; endUserId: string | null }) {
  return request<AgentMemory>(`/agents/${encodeURIComponent(agentId)}/memories`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(90_000),
  })
}

export function updateAgentMemory(agentId: string, memoryId: string, fact: string) {
  return request<AgentMemory>(`/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ fact }),
    signal: AbortSignal.timeout(90_000),
  })
}

export function deleteAgentMemory(agentId: string, memoryId: string) {
  return request<{ ok: true }>(`/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`, {
    method: 'DELETE',
  })
}

export function forgetAgentUser(agentId: string, endUserId: string) {
  const query = new URLSearchParams({ endUserId })
  return request<{ ok: true; deleted: number }>(`/agents/${encodeURIComponent(agentId)}/memories?${query}`, {
    method: 'DELETE',
  })
}

export function connectTelegram(agentId: string, token: string) {
  return request<AgentChannel>(`/agents/${encodeURIComponent(agentId)}/channels/telegram`, {
    method: 'POST',
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(20_000),
  })
}

export function disconnectAgentChannel(agentId: string, channelId: string) {
  return request<{ ok: true }>(
    `/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelId)}`,
    { method: 'DELETE', signal: AbortSignal.timeout(20_000) },
  )
}

export function createKnowledgeBase(name: string) {
  return request('/knowledge-bases', { method: 'POST', body: JSON.stringify({ name }) })
}

export function updateOrganizationLlm(input: Record<string, string>) {
  return request('/organizations/llm', { method: 'PUT', body: JSON.stringify(input) })
}

export function organizationManagementEnabled(): boolean {
  return !!requireDashboardConfig().adminToken
}

export function getManagedOrganizations() {
  return adminRequest<ManagedOrganization[]>('/admin/organizations')
}

export function createManagedOrganization(name: string) {
  return adminRequest<Pick<ManagedOrganization, 'id' | 'name' | 'createdAt'> & { apiKey: string }>('/organizations', { method: 'POST', body: JSON.stringify({ name }) })
}

export function renameManagedOrganization(id: string, name: string) {
  return adminRequest<{ id: string; name: string; createdAt: string }>(`/admin/organizations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}
