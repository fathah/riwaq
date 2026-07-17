import { Playground } from '../../../components/playground'
import { getAgents } from '../../../lib/riwaq'

export default async function PlaygroundPage() {
  const agents = await getAgents()

  return (
    <div className="page-content playground-page">
      <header className="page-header">
        <div><span className="eyebrow">Test your assistant</span><h2>Playground</h2><p>Chat with an agent in the active organization and inspect its sources and token usage.</p></div>
      </header>
      <Playground agents={agents} />
    </div>
  )
}
