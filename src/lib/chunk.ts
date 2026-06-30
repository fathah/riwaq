// Character-based chunker. We approximate ~4 chars/token, so the defaults map to
// roughly 875 tokens per chunk with ~100 tokens of overlap. Splits prefer a
// natural break (newline or space) near the window edge to avoid cutting words.

const MAX_CHARS = 3500
const OVERLAP_CHARS = 400

export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? MAX_CHARS
  const overlapChars = opts.overlapChars ?? OVERLAP_CHARS

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
