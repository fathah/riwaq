'use client'

import { useFormStatus } from 'react-dom'
import {
  createAgentMemoryAction,
  deleteAgentMemoryAction,
  forgetAgentUserAction,
  updateAgentMemoryAction,
} from '../app/actions'
import type { AgentMemory } from '../lib/riwaq'
import { Modal } from './modal'

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return <button className="button button-primary" disabled={pending} type="submit">{pending ? 'Saving…' : label}</button>
}

export function AddAgentMemoryModal({ agentId }: { agentId: string }) {
  return (
    <Modal trigger="Add memory" title="Add memory" description="Store a durable fact for every user or for one specific end-user identity.">
      <form action={createAgentMemoryAction} className="modal-form">
        <input name="agentId" type="hidden" value={agentId} />
        <label><span>Scope</span><select name="scope" defaultValue="agent"><option value="agent">Agent-wide</option><option value="user">Specific end user</option></select></label>
        <label><span>End-user identity</span><input name="endUserId" maxLength={500} placeholder="telegram:123456789" /><small>Required only for user-specific memory. Use the same stable identity supplied to chat.</small></label>
        <label><span>Fact</span><textarea name="fact" required maxLength={1000} rows={5} placeholder="Prefers answers under 50 words." /></label>
        <footer className="modal-actions"><span>Riwaq generates a semantic embedding when saved.</span><SaveButton label="Add memory" /></footer>
      </form>
    </Modal>
  )
}

export function EditAgentMemoryModal({ agentId, memory }: { agentId: string; memory: AgentMemory }) {
  return (
    <Modal tone="secondary" trigger="Edit" title="Edit memory" description="Update the fact while preserving its current user scope.">
      <form action={updateAgentMemoryAction} className="modal-form">
        <input name="agentId" type="hidden" value={agentId} />
        <input name="memoryId" type="hidden" value={memory.id} />
        <label><span>Scope</span><input disabled value={memory.endUserId ?? 'Agent-wide'} /></label>
        <label><span>Fact</span><textarea name="fact" required maxLength={1000} rows={6} defaultValue={memory.fact} autoFocus /></label>
        <footer className="modal-actions"><span>The embedding is regenerated after editing.</span><SaveButton label="Save memory" /></footer>
      </form>
    </Modal>
  )
}

export function DeleteAgentMemoryModal({ agentId, memory }: { agentId: string; memory: AgentMemory }) {
  return (
    <Modal tone="secondary" trigger="Delete" title="Delete memory" description="This fact will no longer be recalled in future conversations.">
      <form action={deleteAgentMemoryAction} className="modal-form">
        <input name="agentId" type="hidden" value={agentId} />
        <input name="memoryId" type="hidden" value={memory.id} />
        <div className="delete-summary"><strong>{memory.fact}</strong><span>This cannot be undone.</span></div>
        <footer className="modal-actions"><span>Existing conversation messages are not deleted.</span><button className="button button-danger" type="submit">Delete memory</button></footer>
      </form>
    </Modal>
  )
}

export function ForgetAgentUserModal({ agentId, endUserId }: { agentId: string; endUserId: string }) {
  return (
    <Modal tone="secondary" trigger="Forget user" title="Forget user memories" description="Remove every long-term memory this agent has stored for this identity.">
      <form action={forgetAgentUserAction} className="modal-form">
        <input name="agentId" type="hidden" value={agentId} />
        <input name="endUserId" type="hidden" value={endUserId} />
        <div className="delete-summary"><strong>{endUserId}</strong><span>Conversation history remains; only extracted long-term facts are removed.</span></div>
        <footer className="modal-actions"><span>This cannot be undone.</span><button className="button button-danger" type="submit">Forget user</button></footer>
      </form>
    </Modal>
  )
}
