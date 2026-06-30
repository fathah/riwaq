// Turn an uploaded file into plain text. Start small: PDF + TXT + MD + CSV.
// Add DOCX (mammoth) etc. later by extending the switch.

export async function parseToText(name: string, mime: string, buffer: Buffer): Promise<string> {
  const ext = name.toLowerCase().split('.').pop() ?? ''

  if (ext === 'pdf' || mime === 'application/pdf') {
    // Import the inner module directly to avoid pdf-parse's debug bootstrap.
    const mod = await import('pdf-parse/lib/pdf-parse.js')
    const pdf = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>
    const data = await pdf(buffer)
    return data.text
  }

  // txt, md, csv, json, and anything else: treat as UTF-8 text.
  return buffer.toString('utf-8')
}
