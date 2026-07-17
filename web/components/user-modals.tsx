'use client'

import { useFormStatus } from 'react-dom'
import {
  connectUserAction,
  createAgentMemoryAction,
  disconnectUserIdentityAction,
  updateUserAction,
} from '../app/actions'
import type { Agent, EndUser, UserIdentity } from '../lib/riwaq'
import { Modal } from './modal'

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return <button className="button button-primary" disabled={pending} type="submit">{pending ? 'Saving…' : label}</button>
}

export function ConnectUserModal() {
  return (
    <Modal trigger="Connect user" title="Connect user" description="Use the stable ID from your own customer database, then optionally attach a messaging or commerce identity.">
      <form action={connectUserAction} className="modal-form">
        <label><span>Canonical user ID</span><input name="userId" required maxLength={500} placeholder="customer_4821" autoFocus /><small>This should be the durable ID your business already owns.</small></label>
        <label><span>Display name</span><input name="displayName" maxLength={200} placeholder="Amina Rahman" /></label>
        <div className="form-grid">
          <label><span>Provider</span><input name="provider" maxLength={100} placeholder="shopify, telegram…" /></label>
          <label><span>Namespace</span><input name="namespace" maxLength={200} placeholder="default or store ID" /></label>
        </div>
        <label><span>External user ID</span><input name="externalUserId" maxLength={500} placeholder="platform_customer_849" /><small>Provider and external ID may be left empty and linked later.</small></label>
        <label className="checkbox-label"><input name="mergeExisting" type="checkbox" /><span>Merge an existing auto-created platform user, including memories and reminders.</span></label>
        <footer className="modal-actions"><span>The same call is safe to repeat.</span><SaveButton label="Connect user" /></footer>
      </form>
    </Modal>
  )
}

export function AddUserIdentityModal({ user }: { user: EndUser }) {
  return (
    <Modal trigger="Link identity" title="Link platform identity" description={`Connect another app or store identity to ${user.displayName || user.id}.`}>
      <form action={connectUserAction} className="modal-form">
        <input name="userId" type="hidden" value={user.id} />
        <input name="existingUserId" type="hidden" value={user.id} />
        <div className="form-grid">
          <label><span>Provider</span><input name="provider" required maxLength={100} placeholder="telegram" autoFocus /></label>
          <label><span>Namespace</span><input name="namespace" maxLength={200} placeholder="default or store ID" /></label>
        </div>
        <label><span>External user ID</span><input name="externalUserId" required maxLength={500} placeholder="123456789" /></label>
        <label className="checkbox-label"><input name="mergeExisting" type="checkbox" /><span>If this identity already has a Riwaq user, merge its history, memories, and reminders here.</span></label>
        <footer className="modal-actions"><span>Future messages resolve to {user.id}.</span><SaveButton label="Link identity" /></footer>
      </form>
    </Modal>
  )
}

export function EditUserModal({ user }: { user: EndUser }) {
  return (
    <Modal tone="secondary" trigger="Edit name" title="Edit user" description="The canonical ID stays unchanged so integrations remain stable.">
      <form action={updateUserAction} className="modal-form">
        <input name="userId" type="hidden" value={user.id} />
        <label><span>Canonical user ID</span><input disabled value={user.id} /></label>
        <label><span>Display name</span><input name="displayName" maxLength={200} defaultValue={user.displayName || ''} autoFocus /></label>
        <footer className="modal-actions"><span>Leave empty to clear the name.</span><SaveButton label="Save user" /></footer>
      </form>
    </Modal>
  )
}

export function DisconnectIdentityModal({ userId, identity }: { userId: string; identity: UserIdentity }) {
  return (
    <Modal tone="secondary" trigger="Disconnect" title="Disconnect identity" description="New messages from this platform identity will no longer resolve to this user.">
      <form action={disconnectUserIdentityAction} className="modal-form">
        <input name="userId" type="hidden" value={userId} />
        <input name="identityId" type="hidden" value={identity.id} />
        <div className="delete-summary"><strong>{identity.provider} · {identity.externalUserId}</strong><span>Existing memories and conversations remain on {userId}.</span></div>
        <footer className="modal-actions"><span>This only removes the mapping.</span><button className="button button-danger" type="submit">Disconnect</button></footer>
      </form>
    </Modal>
  )
}

export function AddUserMemoryModal({ userId, agents }: { userId: string; agents: Agent[] }) {
  return (
    <Modal trigger="Add memory" title="Add user memory" description="Store a durable fact for this user on one agent.">
      <form action={createAgentMemoryAction} className="modal-form">
        <input name="scope" type="hidden" value="user" />
        <input name="endUserId" type="hidden" value={userId} />
        <input name="returnPath" type="hidden" value={`/users/${encodeURIComponent(userId)}`} />
        <label><span>Agent</span><select name="agentId" required defaultValue=""><option disabled value="">Choose an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label><span>Fact</span><textarea name="fact" required maxLength={1000} rows={5} placeholder="Prefers concise replies and delivery after 6 PM." /></label>
        <footer className="modal-actions"><span>Only the selected agent recalls this fact.</span><SaveButton label="Add memory" /></footer>
      </form>
    </Modal>
  )
}
