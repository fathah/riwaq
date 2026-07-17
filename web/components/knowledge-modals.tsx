'use client'

import { useFormStatus } from 'react-dom'
import { deleteKnowledgeDocumentAction, uploadKnowledgeAction } from '../app/actions'
import type { KnowledgeDocument } from '../lib/riwaq'
import { Modal } from './modal'

function UploadButton() {
  const { pending } = useFormStatus()
  return <button className="button button-primary" disabled={pending} type="submit">{pending ? 'Adding…' : 'Add knowledge'}</button>
}

export function AddKnowledgeModal({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  return (
    <Modal trigger="Add knowledge" title="Add knowledge" description="Upload a document or paste text for Riwaq to index and retrieve.">
      <form action={uploadKnowledgeAction} className="modal-form">
        <input name="knowledgeBaseId" type="hidden" value={knowledgeBaseId} />
        <label><span>Document name</span><input maxLength={300} name="name" placeholder="Support handbook" /></label>
        <label className="file-field"><span>Upload file</span><input accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" name="file" type="file" /><small>PDF, TXT, or Markdown. Maximum 15 MB.</small></label>
        <div className="form-divider"><span>or paste text</span></div>
        <label><span>Knowledge text</span><textarea name="text" placeholder="Paste policies, FAQs, product information, or other source material…" rows={8} /></label>
        <footer className="modal-actions"><span>Processing runs in the background after upload.</span><UploadButton /></footer>
      </form>
    </Modal>
  )
}

export function DeleteKnowledgeDocumentModal({ document }: { document: KnowledgeDocument }) {
  return (
    <Modal tone="secondary" trigger="Delete" title="Delete knowledge" description="This permanently removes the document and all of its indexed chunks.">
      <form action={deleteKnowledgeDocumentAction} className="modal-form">
        <input name="knowledgeBaseId" type="hidden" value={document.knowledgeBaseId} />
        <input name="documentId" type="hidden" value={document.id} />
        <div className="delete-summary"><strong>{document.name}</strong><span>This cannot be undone.</span></div>
        <footer className="modal-actions"><span>Agents will stop retrieving this knowledge immediately.</span><button className="button button-danger" type="submit">Delete document</button></footer>
      </form>
    </Modal>
  )
}
