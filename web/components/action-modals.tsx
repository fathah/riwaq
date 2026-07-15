'use client'

import { useFormStatus } from 'react-dom'
import { createAgentAction, createKnowledgeBaseAction, updateLlmAction } from '../app/actions'
import type { Organization } from '../lib/riwaq'
import { Modal } from './modal'

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return <button className="button button-primary" disabled={pending} type="submit">{pending ? 'Saving…' : label}</button>
}

export function CreateAgentModal() {
  return (
    <Modal trigger="New agent" title="Create an agent" description="A private knowledge base is created for every new agent.">
      <form action={createAgentAction} className="modal-form">
        <label><span>Name</span><input name="name" required maxLength={200} autoFocus placeholder="Customer support" /></label>
        <label><span>System prompt</span><textarea name="systemPrompt" rows={5} maxLength={20000} placeholder="You are a precise support assistant…" /></label>
        <div className="form-row">
          <label><span>Provider</span><select name="provider" defaultValue=""><option value="">Inherit organization default</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option></select></label>
          <label><span>Model</span><input name="model" placeholder="Inherit default" /></label>
        </div>
        <footer className="modal-actions"><span>Agent settings can inherit the organization LLM.</span><SubmitButton label="Create agent" /></footer>
      </form>
    </Modal>
  )
}

export function CreateKnowledgeBaseModal() {
  return (
    <Modal trigger="New knowledge base" title="Create a knowledge base" description="Shared knowledge can be connected to multiple agents.">
      <form action={createKnowledgeBaseAction} className="modal-form">
        <label><span>Name</span><input name="name" required autoFocus placeholder="Company policies" /></label>
        <footer className="modal-actions"><span>Documents can be added after creation.</span><SubmitButton label="Create knowledge base" /></footer>
      </form>
    </Modal>
  )
}

export function EditLlmModal({ organization }: { organization: Organization }) {
  return (
    <Modal tone="secondary" trigger="Edit configuration" title="Organization LLM" description="Update the provider defaults inherited by your agents.">
      <form action={updateLlmAction} className="modal-form">
        <div className="form-row">
          <label><span>Provider</span><select name="provider" defaultValue={organization.llm.provider ?? ''}><option value="">Keep current</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option></select></label>
          <label><span>Model</span><input name="model" defaultValue={organization.llm.model ?? ''} placeholder="Deployment default" /></label>
        </div>
        <label><span>Base URL</span><input name="baseUrl" type="url" defaultValue={organization.llm.baseUrl ?? ''} placeholder="https://api.openai.com/v1" /></label>
        <label><span>New API key</span><input name="apiKey" type="password" autoComplete="new-password" placeholder={organization.llm.hasApiKey ? 'Leave blank to keep the current key' : 'Enter a provider key'} /></label>
        <footer className="modal-actions"><span>Only non-empty fields are updated.</span><SubmitButton label="Save settings" /></footer>
      </form>
    </Modal>
  )
}
