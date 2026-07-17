'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { clearDashboardSession, createDashboardSession, requireDashboardSession, setSelectedOrganizationId } from '../lib/auth'
import { createAgent, createKnowledgeBase, createManagedOrganization, deleteKnowledgeDocument, getManagedOrganizations, renameManagedOrganization, updateOrganizationLlm, uploadKnowledgeDocument } from '../lib/riwaq'

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed'
}

function finish(path: string, kind: 'notice' | 'error', message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`)
}

export async function loginAction(formData: FormData): Promise<void> {
  const ok = await createDashboardSession(field(formData, 'token'))
  if (!ok) finish('/', 'error', 'Invalid dashboard access token')
  redirect('/overview')
}

export async function logoutAction(): Promise<void> {
  await clearDashboardSession()
  redirect('/')
}

export async function createAgentAction(formData: FormData): Promise<void> {
  await requireDashboardSession()
  const name = field(formData, 'name')
  if (!name) finish('/agents', 'error', 'Agent name is required')
  const systemPrompt = field(formData, 'systemPrompt')
  const provider = field(formData, 'provider')
  const model = field(formData, 'model')

  try {
    await createAgent({
      name,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    })
  } catch (error) {
    finish('/agents', 'error', messageOf(error))
  }
  revalidatePath('/agents')
  revalidatePath('/overview')
  finish('/agents', 'notice', `Agent “${name}” created`)
}

export async function createKnowledgeBaseAction(formData: FormData): Promise<void> {
  await requireDashboardSession()
  const name = field(formData, 'name')
  if (!name) finish('/knowledge', 'error', 'Knowledge-base name is required')
  try {
    await createKnowledgeBase(name)
  } catch (error) {
    finish('/knowledge', 'error', messageOf(error))
  }
  revalidatePath('/knowledge')
  revalidatePath('/overview')
  finish('/knowledge', 'notice', `Knowledge base “${name}” created`)
}

export async function uploadKnowledgeAction(formData: FormData): Promise<void> {
  await requireDashboardSession()
  const knowledgeBaseId = field(formData, 'knowledgeBaseId')
  const path = `/knowledge/${encodeURIComponent(knowledgeBaseId)}`
  if (!knowledgeBaseId) finish('/knowledge', 'error', 'Knowledge base is required')

  const file = formData.get('file')
  const name = field(formData, 'name')
  const pastedText = field(formData, 'text')
  try {
    if (file instanceof File && file.size > 0) {
      const upload = new FormData()
      upload.set('file', file)
      if (name) upload.set('name', name)
      await uploadKnowledgeDocument(knowledgeBaseId, upload)
    } else if (pastedText) {
      await uploadKnowledgeDocument(knowledgeBaseId, { name: name || 'Pasted knowledge', text: pastedText })
    } else {
      finish(path, 'error', 'Choose a file or paste some text')
    }
  } catch (error) {
    finish(path, 'error', messageOf(error))
  }
  revalidatePath(path)
  revalidatePath('/knowledge')
  revalidatePath('/overview')
  finish(path, 'notice', 'Knowledge added and queued for indexing')
}

export async function deleteKnowledgeDocumentAction(formData: FormData): Promise<void> {
  await requireDashboardSession()
  const knowledgeBaseId = field(formData, 'knowledgeBaseId')
  const documentId = field(formData, 'documentId')
  const path = `/knowledge/${encodeURIComponent(knowledgeBaseId)}`
  if (!knowledgeBaseId || !documentId) finish('/knowledge', 'error', 'Document is required')
  try {
    await deleteKnowledgeDocument(knowledgeBaseId, documentId)
  } catch (error) {
    finish(path, 'error', messageOf(error))
  }
  revalidatePath(path)
  revalidatePath('/knowledge')
  revalidatePath('/overview')
  finish(path, 'notice', 'Knowledge document deleted')
}

export async function updateLlmAction(formData: FormData): Promise<void> {
  await requireDashboardSession()
  const input: Record<string, string> = {}
  for (const name of ['provider', 'baseUrl', 'model', 'apiKey']) {
    const value = field(formData, name)
    if (value) input[name] = value
  }
  if (Object.keys(input).length === 0) finish('/settings', 'error', 'Enter at least one LLM setting to update')

  try {
    await updateOrganizationLlm(input)
  } catch (error) {
    finish('/settings', 'error', messageOf(error))
  }
  revalidatePath('/settings')
  finish('/settings', 'notice', 'Organization LLM settings updated')
}

export async function switchOrganizationAction(formData: FormData): Promise<void> {
  await requireDashboardSession()
  const organizationId = field(formData, 'organizationId')
  const organizations = await getManagedOrganizations()
  const selected = organizations.find((organization) => organization.id === organizationId)
  if (!selected) finish('/organizations', 'error', 'Organization not found')
  await setSelectedOrganizationId(selected.id)
  revalidatePath('/', 'layout')
  finish('/overview', 'notice', `Switched to ${selected.name}`)
}

export type CreateOrganizationState = { error?: string; apiKey?: string; organizationName?: string }

export async function createOrganizationAction(
  _state: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  await requireDashboardSession()
  const name = field(formData, 'name')
  if (!name) return { error: 'Organization name is required' }
  try {
    const organization = await createManagedOrganization(name)
    await setSelectedOrganizationId(organization.id)
    revalidatePath('/', 'layout')
    return { apiKey: organization.apiKey, organizationName: organization.name }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

export async function renameOrganizationAction(formData: FormData): Promise<void> {
  await requireDashboardSession()
  const organizationId = field(formData, 'organizationId')
  const name = field(formData, 'name')
  if (!organizationId || !name) finish('/organizations', 'error', 'Organization and name are required')
  try {
    await renameManagedOrganization(organizationId, name)
  } catch (error) {
    finish('/organizations', 'error', messageOf(error))
  }
  revalidatePath('/', 'layout')
  finish('/organizations', 'notice', `Organization renamed to “${name}”`)
}
