'use client'

import { useId, useMemo, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { useFormStatus } from 'react-dom'
import {
  createAgentMemoryAction,
  deleteAgentMemoryAction,
  forgetAgentUserAction,
  updateAgentMemoryAction,
} from '../app/actions'
import type { AgentMemory, EndUser } from '../lib/riwaq'
import { Modal } from './modal'

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return <button className="button button-primary" disabled={pending} type="submit">{pending ? 'Saving…' : label}</button>
}

function userLabel(user: EndUser): string {
  return user.displayName ? `${user.displayName} · ${user.id}` : user.id
}

function MemoryScopeFields({ users }: { users: EndUser[] }) {
  const [scope, setScope] = useState<'agent' | 'user'>('agent')
  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()

  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matches = needle
      ? users.filter((user) => userLabel(user).toLocaleLowerCase().includes(needle))
      : users
    return matches.slice(0, 8)
  }, [query, users])

  function chooseUser(user: EndUser) {
    setSelectedUserId(user.id)
    setQuery(userLabel(user))
    setOpen(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (filteredUsers.length === 0) return
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + direction + filteredUsers.length) % filteredUsers.length)
      return
    }
    if (event.key === 'Enter' && open && filteredUsers[activeIndex]) {
      event.preventDefault()
      chooseUser(filteredUsers[activeIndex])
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }

  return (
    <>
      <label>
        <span>Scope</span>
        <select name="scope" value={scope} onChange={(event) => setScope(event.target.value as 'agent' | 'user')}>
          <option value="agent">Agent-wide</option>
          <option disabled={users.length === 0} value="user">Specific end user</option>
        </select>
      </label>
      {scope === 'user' ? (
        <div className="memory-user-picker" onBlur={handleBlur}>
          <input name="endUserId" type="hidden" value={selectedUserId} />
          <label>
            <span>End user</span>
            <input
              aria-activedescendant={open && filteredUsers[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={open}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value)
                setSelectedUserId('')
                setActiveIndex(0)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder="Search by name or user ID…"
              role="combobox"
              value={query}
            />
          </label>
          {open ? (
            <div aria-label="End users" className="memory-user-menu" id={listboxId} role="listbox">
              {filteredUsers.length === 0 ? (
                <p>No matching users</p>
              ) : filteredUsers.map((user, index) => (
                <button
                  aria-selected={user.id === selectedUserId}
                  className={index === activeIndex ? 'memory-user-option option-active' : 'memory-user-option'}
                  id={`${listboxId}-${index}`}
                  key={user.id}
                  onClick={() => chooseUser(user)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <span className="memory-user-avatar">{(user.displayName || user.id).slice(0, 1).toUpperCase()}</span>
                  <span><strong>{user.displayName || user.id}</strong><small>{user.id}</small></span>
                  {user.id === selectedUserId ? <span aria-hidden="true" className="memory-user-check">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          <small>Choose an existing organization user. Type to filter by name or canonical ID.</small>
        </div>
      ) : null}
    </>
  )
}

export function AddAgentMemoryModal({ agentId, users, returnPath }: { agentId: string; users: EndUser[]; returnPath?: string }) {
  return (
    <Modal trigger="Add memory" title="Add memory" description="Store a durable fact for every user or for one specific end-user identity.">
      <form action={createAgentMemoryAction} className="modal-form">
        <input name="agentId" type="hidden" value={agentId} />
        {returnPath ? <input name="returnPath" type="hidden" value={returnPath} /> : null}
        <MemoryScopeFields users={users} />
        <label><span>Fact</span><textarea name="fact" required maxLength={1000} rows={5} placeholder="Prefers answers under 50 words." /></label>
        <footer className="modal-actions"><span>Riwaq generates a semantic embedding when saved.</span><SaveButton label="Add memory" /></footer>
      </form>
    </Modal>
  )
}

export function EditAgentMemoryModal({ agentId, memory, returnPath }: { agentId: string; memory: AgentMemory; returnPath?: string }) {
  return (
    <Modal tone="secondary" trigger="Edit" title="Edit memory" description="Update the fact while preserving its current user scope.">
      <form action={updateAgentMemoryAction} className="modal-form">
        <input name="agentId" type="hidden" value={agentId} />
        {returnPath ? <input name="returnPath" type="hidden" value={returnPath} /> : null}
        <input name="memoryId" type="hidden" value={memory.id} />
        <label><span>Scope</span><input disabled value={memory.endUserId ?? 'Agent-wide'} /></label>
        <label><span>Fact</span><textarea name="fact" required maxLength={1000} rows={6} defaultValue={memory.fact} autoFocus /></label>
        <footer className="modal-actions"><span>The embedding is regenerated after editing.</span><SaveButton label="Save memory" /></footer>
      </form>
    </Modal>
  )
}

export function DeleteAgentMemoryModal({ agentId, memory, returnPath }: { agentId: string; memory: AgentMemory; returnPath?: string }) {
  return (
    <Modal tone="secondary" trigger="Delete" title="Delete memory" description="This fact will no longer be recalled in future conversations.">
      <form action={deleteAgentMemoryAction} className="modal-form">
        <input name="agentId" type="hidden" value={agentId} />
        {returnPath ? <input name="returnPath" type="hidden" value={returnPath} /> : null}
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
