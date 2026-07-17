'use client'

import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import { switchOrganizationAction } from '../app/actions'
import type { ManagedOrganization } from '../lib/riwaq'

export function OrganizationSwitcher({ activeId, organizations }: { activeId: string; organizations: ManagedOrganization[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLFormElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const active = organizations.find((organization) => organization.id === activeId) ?? organizations[0]

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const activeIndex = Math.max(0, organizations.findIndex((organization) => organization.id === activeId))
    requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
  }, [activeId, open, organizations])

  function selectOrganization(organization: ManagedOrganization) {
    setOpen(false)
    if (organization.id === activeId || !inputRef.current) {
      triggerRef.current?.focus()
      return
    }
    inputRef.current.value = organization.id
    rootRef.current?.requestSubmit()
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = optionRefs.current.findIndex((option) => option === document.activeElement)
    const last = organizations.length - 1
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowDown' ? Math.min(current + 1, last) : Math.max(current - 1, 0)
    optionRefs.current[next]?.focus()
  }

  return (
    <form action={switchOrganizationAction} className="organization-switcher" ref={rootRef}>
      <input defaultValue={activeId} name="organizationId" ref={inputRef} type="hidden" />
      <button
        aria-label={`Switch organization. Current organization: ${active?.name ?? 'none'}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="organization-switcher-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        <span>{active?.name ?? 'Select organization'}</span>
        <svg aria-hidden viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div aria-label="Organizations" className="organization-switcher-menu" onKeyDown={moveFocus} role="listbox">
          {organizations.map((organization, index) => (
            <button
              aria-selected={organization.id === activeId}
              className={organization.id === activeId ? 'organization-switcher-option option-active' : 'organization-switcher-option'}
              key={organization.id}
              onClick={() => selectOrganization(organization)}
              ref={(element) => { optionRefs.current[index] = element }}
              role="option"
              type="button"
            >
              <span>{organization.name}</span>
              {organization.id === activeId && <span aria-hidden className="organization-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </form>
  )
}
