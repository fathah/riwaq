'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { clearDashboardSession, createDashboardSession, requireDashboardSession } from '../lib/auth'
import { createAgent, createKnowledgeBase, updateOrganizationLlm } from '../lib/riwaq'

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
