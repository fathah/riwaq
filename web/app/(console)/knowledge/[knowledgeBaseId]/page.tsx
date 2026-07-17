import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AddKnowledgeModal } from '../../../../components/knowledge-modals'
import { Icon } from '../../../../components/icons'
import { getKnowledgeBases, getKnowledgeDocuments } from '../../../../lib/riwaq'

function date(value: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

export default async function KnowledgeBasePage({ params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const { knowledgeBaseId } = await params
  const [knowledgeBases, documents] = await Promise.all([getKnowledgeBases(), getKnowledgeDocuments(knowledgeBaseId)])
  const knowledgeBase = knowledgeBases.find((item) => item.id === knowledgeBaseId)
  if (!knowledgeBase) notFound()

  return (
    <div className="page-content">
      <Link className="back-link" href="/knowledge">← Knowledge bases</Link>
      <header className="page-header">
        <div><span className="eyebrow">{knowledgeBase.isDefault ? 'Private knowledge' : 'Shared knowledge'}</span><h2>{knowledgeBase.name}</h2><p>{knowledgeBase.isDefault ? 'Add source material and inspect exactly what Riwaq has indexed.' : 'Available to every agent in this organization. Add source material and inspect exactly what Riwaq has indexed.'}</p></div>
        <AddKnowledgeModal knowledgeBaseId={knowledgeBase.id} />
      </header>
      <section className="list-card page-card">
        {documents.length === 0 ? <div className="empty-state"><span>+</span><h3>No knowledge yet</h3><p>Upload a PDF, TXT, or Markdown file, or paste text directly.</p></div> : documents.map((document) => (
          <Link className="row-item row-link" href={`/knowledge/${knowledgeBase.id}/documents/${document.id}`} key={document.id}>
            <span className="row-icon"><Icon name="book" /></span>
            <div className="row-copy"><strong>{document.name}</strong><span>{document.source === 'file' ? 'Uploaded file' : 'Pasted text'} · {date(document.createdAt)}</span></div>
            <div className="row-meta"><span className={`document-status status-${document.status}`}>{document.status}</span><span className="row-open">View knowledge →</span></div>
          </Link>
        ))}
      </section>
    </div>
  )
}
