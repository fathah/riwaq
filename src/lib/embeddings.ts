import { env } from '../env'
import { EMBEDDING_DIM } from '../db/schema'

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
const MODEL = 'voyage-3'
const BATCH = 128 // Voyage accepts up to 128 inputs per request.

export { EMBEDDING_DIM }

type InputType = 'document' | 'query'

/**
 * Embed an array of texts. Use 'document' when storing, 'query' when searching —
 * Voyage tunes the vector slightly for each side, which improves retrieval.
 */
export async function embed(texts: string[], inputType: InputType = 'document'): Promise<number[][]> {
  if (!env.EMBEDDINGS_API_KEY) {
    throw new Error('EMBEDDINGS_API_KEY is not set — cannot embed.')
  }
  if (texts.length === 0) return []

  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.EMBEDDINGS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, input: slice, input_type: inputType }),
    })
    if (!res.ok) {
      throw new Error(`Voyage embeddings error ${res.status}: ${await res.text()}`)
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] }
    for (const d of json.data) out.push(d.embedding)
  }
  return out
}

export async function embedOne(text: string, inputType: InputType = 'query'): Promise<number[]> {
  const [v] = await embed([text], inputType)
  if (!v) throw new Error('embedding failed: empty response')
  return v
}
