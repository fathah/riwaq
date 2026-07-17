import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DeleteKnowledgeDocumentModal } from '../../../../../../components/knowledge-modals'
import { getKnowledgeBases, getKnowledgeDocument, RiwaqApiError } from '../../../../../../lib/riwaq'

export default async function KnowledgeDocumentPage({ params }: { params: Promise<{ knowledgeBaseId: string; documentId: string }> }) {
  const { knowledgeBaseId, documentId } = await params
  const knowledgeBases = await getKnowledgeBases()
  const knowledgeBase = knowledgeBases.find((item) => item.id === knowledgeBaseId)
  if (!knowledgeBase) notFound()

  let detail
  try {
    detail = await getKnowledgeDocument(knowledgeBaseId, documentId)
  } catch (error) {
    if (error instanceof RiwaqApiError && error.status === 404) notFound()
    throw error
  }

  const chunks = [...detail.chunks].sort((a, b) => (a.metadata.index ?? 0) - (b.metadata.index ?? 0))
  return (
    <div className="page-content">
      <Link className="back-link" href={`/knowledge/${knowledgeBase.id}`}>← {knowledgeBase.name}</Link>
      <header className="page-header document-page-header">
        <div><span className="eyebrow">Indexed document</span><h2>{detail.document.name}</h2><p>{chunks.length} searchable {chunks.length === 1 ? 'chunk' : 'chunks'} · {detail.document.source === 'file' ? 'Uploaded file' : 'Pasted text'}</p></div>
        <DeleteKnowledgeDocumentModal document={detail.document} />
      </header>

      {detail.document.status === 'processing' ? (
        <section className="knowledge-state"><strong>Indexing in progress</strong><p>Riwaq is extracting, chunking, and embedding this document. Refresh shortly.</p></section>
      ) : detail.document.status === 'error' ? (
        <section className="knowledge-state knowledge-state-error"><strong>Indexing failed</strong><p>Delete this document and upload it again, or check the API worker logs.</p></section>
      ) : chunks.length === 0 ? (
        <section className="knowledge-state"><strong>No searchable text</strong><p>The document was processed but produced no text chunks.</p></section>
      ) : (
        <section className="knowledge-chunks">
          <header><div><span className="eyebrow">Retrieval source</span><h3>Indexed knowledge</h3></div><span>{chunks.length}{detail.page.hasMore ? '+' : ''} chunks</span></header>
          {chunks.map((chunk, index) => <article className="knowledge-chunk" key={chunk.id}><span>{String(index + 1).padStart(2, '0')}</span><p>{chunk.content}</p></article>)}
          {detail.page.hasMore ? <p className="knowledge-more">Showing the first 200 chunks.</p> : null}
        </section>
      )}
    </div>
  )
}
