'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from './icons'

type ModalProps = {
  trigger: string
  title: string
  description: string
  children: ReactNode
  tone?: 'primary' | 'secondary'
  onOpen?: () => void
}

export function Modal({ trigger, title, description, children, tone = 'primary', onOpen }: ModalProps) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <>
      <button className={`button ${tone === 'primary' ? 'button-primary' : 'button-secondary'}`} type="button" onClick={() => { onOpen?.(); setOpen(true) }}>
        {trigger} {tone === 'primary' ? <Icon name="plus" /> : null}
      </button>
      <dialog
        aria-labelledby={titleId}
        className="modal"
        ref={dialogRef}
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === dialogRef.current) setOpen(false) }}
      >
        <section className="modal-card">
          <header className="modal-header">
            <div><span className="eyebrow">Riwaq console</span><h2 id={titleId}>{title}</h2><p>{description}</p></div>
            <button aria-label="Close dialog" className="icon-button" type="button" onClick={() => setOpen(false)}><Icon name="close" /></button>
          </header>
          {children}
        </section>
      </dialog>
    </>
  )
}
