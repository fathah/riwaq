// Character-based chunker. Splits prefer a natural break (newline or space) near
// the window edge to avoid cutting words. The defaults come from env and are sized
// to fit the shipped local embedder's real token cap — an oversized chunk would be
// silently truncated at embed time, making its tail unsearchable. Long-context
// embedders can raise CHUNK_MAX_CHARS for fewer, larger chunks.
import { env } from '../env'

export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? env.CHUNK_MAX_CHARS
  const overlapChars = opts.overlapChars ?? env.CHUNK_OVERLAP_CHARS

  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length === 0) return []
  if (clean.length <= maxChars) return [clean]

  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length)
    if (end < clean.length) {
      const slice = clean.slice(start, end)
      const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '))
      // Only honor the break if it isn't absurdly early in the window.
      if (lastBreak > maxChars * 0.5) end = start + lastBreak
    }
    const piece = clean.slice(start, end).trim()
    if (piece.length > 0) chunks.push(piece)
    if (end >= clean.length) break
    start = Math.max(end - overlapChars, start + 1)
  }
  return chunks
}
