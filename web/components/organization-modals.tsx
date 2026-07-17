'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { createOrganizationAction, renameOrganizationAction, type CreateOrganizationState } from '../app/actions'
import type { ManagedOrganization } from '../lib/riwaq'
import { Modal } from './modal'

const initialState: CreateOrganizationState = {}

function CreateOrganizationForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, initialState)
  const router = useRouter()

  useEffect(() => { if (state.error) toast.error(state.error) }, [state.error])

  if (state.apiKey) {
    return (
      <div className="modal-form secret-result">
        <div className="secret-success"><span>✓</span><div><strong>{state.organizationName} created</strong><p>Copy this organization API key now. Riwaq will not display it again.</p></div></div>
        <code>{state.apiKey}</code>
        <footer className="modal-actions">
          <button className="button button-secondary" type="button" onClick={async () => { await navigator.clipboard.writeText(state.apiKey!); toast.success('API key copied') }}>Copy API key</button>
          <button className="button button-primary" type="button" onClick={() => { router.push('/overview'); router.refresh() }}>Open organization</button>
        </footer>
      </div>
    )
  }

  return (
    <form action={action} className="modal-form">
      <label><span>Name</span><input name="name" required autoFocus maxLength={200} placeholder="Acme support" /></label>
      <footer className="modal-actions"><span>A unique API key is generated and shown once.</span><button className="button button-primary" disabled={pending} type="submit">{pending ? 'Creating…' : 'Create organization'}</button></footer>
    </form>
  )
}

export function CreateOrganizationModal() {
  const [instance, setInstance] = useState(0)
  return <Modal trigger="New organization" title="Create an organization" description="Provision an isolated workspace with its own agents, knowledge, and API key." onOpen={() => setInstance((value) => value + 1)}><CreateOrganizationForm key={instance} /></Modal>
}

export function RenameOrganizationModal({ organization }: { organization: ManagedOrganization }) {
  return (
    <Modal tone="secondary" trigger="Rename" title="Rename organization" description="Change the console label without affecting API keys or integrations.">
      <form action={renameOrganizationAction} className="modal-form">
        <input name="organizationId" type="hidden" value={organization.id} />
        <label><span>Name</span><input name="name" required autoFocus maxLength={200} defaultValue={organization.name} /></label>
        <footer className="modal-actions"><span>The organization ID remains unchanged.</span><button className="button button-primary" type="submit">Save name</button></footer>
      </form>
    </Modal>
  )
}
