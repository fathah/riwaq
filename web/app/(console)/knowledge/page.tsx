import { CreateKnowledgeBaseModal } from '../../../components/action-modals'
import { Icon } from '../../../components/icons'
import { getKnowledgeBases } from '../../../lib/riwaq'

export default async function KnowledgePage() {
  const knowledgeBases = await getKnowledgeBases()
  return (
    <div className="page-content">
      <header className="page-header"><div><span className="eyebrow">Grounded answers</span><h2>Knowledge bases</h2><p>Keep private agent context separate from reusable organization knowledge.</p></div><CreateKnowledgeBaseModal /></header>
      <section className="list-card page-card">
        {knowledgeBases.map((kb) => (
          <article className="row-item" key={kb.id}>
            <span className={`row-icon ${kb.isDefault ? '' : 'row-icon-violet'}`}><Icon name="book" /></span>
            <div className="row-copy"><strong>{kb.name}</strong><span>{kb.isDefault ? 'Private agent knowledge' : 'Shared organization knowledge'}</span></div>
            <div className="row-meta"><span className={`pill ${kb.isDefault ? '' : 'pill-violet'}`}>{kb.isDefault ? 'Private' : 'Shared'}</span><code>{kb.id.slice(0, 8)}</code></div>
          </article>
        ))}
      </section>
    </div>
  )
}
