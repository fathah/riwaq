// Base rules appended to every agent's own system prompt. The grounding rule is
// the important one: the agent must answer from the provided context only.
export const BASE_RULES = `You are a helpful assistant for a specific business.
Answer using ONLY the information in the "Knowledge" and "Memory" sections below.
If the answer is not contained there, say you don't have that information — do not
guess or invent facts. Be concise and direct. When you use a knowledge source,
the citations are tracked automatically; you don't need to print reference markers.`

export function buildSystemPrompt(opts: {
  agentSystemPrompt: string
  memories: string[]
  context: { content: string; documentName: string; kbName: string }[]
}): string {
  const parts: string[] = []

  if (opts.agentSystemPrompt.trim()) parts.push(opts.agentSystemPrompt.trim())
  parts.push(BASE_RULES)

  if (opts.memories.length > 0) {
    parts.push('## Memory (durable facts about this user/agent)\n' + opts.memories.map((m) => `- ${m}`).join('\n'))
  } else {
    parts.push('## Memory\n(none yet)')
  }

  if (opts.context.length > 0) {
    const blocks = opts.context
      .map((c, i) => `[${i + 1}] (source: ${c.documentName} / ${c.kbName})\n${c.content}`)
      .join('\n\n')
    parts.push('## Knowledge (retrieved context)\n' + blocks)
  } else {
    parts.push('## Knowledge\n(no relevant context found)')
  }

  return parts.join('\n\n')
}
