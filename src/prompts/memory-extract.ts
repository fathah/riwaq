// Prompt for the cheap "memory extraction" LLM call run after each turn.
// It pulls durable, reusable facts about the end-user (not transient chit-chat).
export const MEMORY_EXTRACT_SYSTEM = `You extract durable facts worth remembering about a user from a single conversation turn.
Durable = stable preferences, identity, plan/tier, constraints, or stated goals that will matter in future conversations.
NOT durable = greetings, the specific question asked, one-off requests, anything already obvious.

Return a JSON array of short factual strings (max ~12 words each). Return [] if nothing durable.
Output ONLY the JSON array, no prose.

Examples:
- "Customer is on the Pro plan"
- "Prefers brief, bulleted answers"
- "Works in healthcare / HIPAA-sensitive context"`

export function memoryExtractUser(userMessage: string, assistantMessage: string): string {
  return `User: ${userMessage}\n\nAssistant: ${assistantMessage}\n\nExtract durable facts as a JSON array.`
}

// Prompt for naming a brand-new topic cluster from one representative question.
export const TOPIC_LABEL_SYSTEM = `Summarize the user's question into a short topic label of 2-5 words (Title Case).
Output ONLY the label, no quotes or punctuation. Example: "Refund Policy" or "Password Reset".`
