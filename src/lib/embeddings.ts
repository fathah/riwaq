import { env } from '../env'

// Embedding dimension — locked to the DB columns at migration time.
export const EMBEDDING_DIM = env.EMBEDDING_DIM

export type EmbeddingsProvider = 'voyage' | 'openai' | 'local'
type InputType = 'document' | 'query'

// Auto-resolve: explicit provider wins; else use Voyage if a key is set; else the
// offline in-process model (no key, no network, no extra service).
function resolveProvider(): EmbeddingsProvider {
  if (env.EMBEDDINGS_PROVIDER) return env.EMBEDDINGS_PROVIDER
  return env.EMBEDDINGS_API_KEY ? 'voyage' : 'local'
}

const DEFAULT_MODEL: Record<EmbeddingsProvider, string> = {
  voyage: 'voyage-3',
  openai: 'text-embedding-3-small',
  local: 'Xenova/all-MiniLM-L6-v2', // 384-dim, ~23MB; the canonical transformers.js embedder
}

function modelFor(provider: EmbeddingsProvider): string {
  return env.EMBEDDINGS_MODEL || DEFAULT_MODEL[provider]
}

/**
 * Embed texts. Use 'document' when storing, 'query' when searching. Returns
 * vectors whose length must equal EMBEDDING_DIM (enforced) so they fit the columns.
 */
export async function embed(texts: string[], inputType: InputType = 'document'): Promise<number[][]> {
  if (texts.length === 0) return []
  const provider = resolveProvider()

  let vectors: number[][]
  switch (provider) {
    case 'voyage':
      vectors = await voyageEmbed(texts, inputType)
      break
    case 'openai':
      vectors = await openaiEmbed(texts)
      break
    case 'local':
      vectors = await localEmbed(texts)
      break
  }

  const got = vectors[0]?.length ?? 0
  if (got !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dim mismatch: ${provider}/${modelFor(provider)} returned ${got}, but EMBEDDING_DIM=${EMBEDDING_DIM}. ` +
        `Set EMBEDDING_DIM to ${got} (and re-migrate) or choose a model that outputs ${EMBEDDING_DIM} dims.`,
    )
  }
  return vectors
}

export async function embedOne(text: string, inputType: InputType = 'query'): Promise<number[]> {
  const [v] = await embed([text], inputType)
  if (!v) throw new Error('embedding failed: empty response')
  return v
}

// Bound every remote embedding call so a slow/hanging provider can't wedge an
// ingest or chat turn indefinitely.
const FETCH_TIMEOUT_MS = 30_000

// ---- voyage (REST) ----
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_BATCH = 128

async function voyageEmbed(texts: string[], inputType: InputType): Promise<number[][]> {
  if (!env.EMBEDDINGS_API_KEY) throw new Error('EMBEDDINGS_API_KEY is not set — cannot use the voyage provider.')
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
    const slice = texts.slice(i, i + VOYAGE_BATCH)
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMBEDDINGS_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelFor('voyage'), input: slice, input_type: inputType }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Voyage embeddings error ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { data: { embedding: number[] }[] }
    for (const d of json.data) out.push(d.embedding)
  }
  return out
}

// ---- openai-compatible (REST: OpenAI, Ollama, LM Studio, …) ----
async function openaiEmbed(texts: string[]): Promise<number[][]> {
  if (!env.EMBEDDINGS_API_KEY) throw new Error('EMBEDDINGS_API_KEY is not set — cannot use the openai provider.')
  const res = await fetch(`${env.EMBEDDINGS_BASE_URL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.EMBEDDINGS_API_KEY}`, 'Content-Type': 'application/json' },
    // `dimensions` lets OpenAI text-embedding-3-* match EMBEDDING_DIM; servers that
    // don't support it generally ignore it.
    body: JSON.stringify({ model: modelFor('openai'), input: texts, dimensions: EMBEDDING_DIM }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`OpenAI embeddings error ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[] }
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

// ---- local (in-process, transformers.js — offline, no key) ----
let extractorPromise: Promise<(input: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null

async function getExtractor() {
  if (!extractorPromise) {
    // Imported lazily so the heavy runtime only loads when the local provider is used.
    extractorPromise = import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('feature-extraction', modelFor('local')),
    ) as Promise<(input: string[], opts: object) => Promise<{ tolist(): number[][] }>>
  }
  return extractorPromise
}

async function localEmbed(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist()
}
