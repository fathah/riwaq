import { NextResponse } from 'next/server'
import { isDashboardAuthenticated } from '../../../../lib/auth'
import { chatWithAgent, RiwaqApiError } from '../../../../lib/riwaq'

type PlaygroundRequest = {
  agentId?: unknown
  conversationId?: unknown
  message?: unknown
}

export async function POST(request: Request) {
  if (!(await isDashboardAuthenticated())) {
    return NextResponse.json({ error: 'Dashboard authentication required' }, { status: 401 })
  }

  const body = await request.json().catch(() => null) as PlaygroundRequest | null
  const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : ''

  if (!agentId) return NextResponse.json({ error: 'Select an agent' }, { status: 400 })
  if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 })
  if (message.length > 20_000) return NextResponse.json({ error: 'Message must be 20,000 characters or fewer' }, { status: 400 })

  try {
    const result = await chatWithAgent(agentId, { message, ...(conversationId ? { conversationId } : {}) })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof RiwaqApiError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502
      return NextResponse.json({ error: error.message }, { status })
    }
    return NextResponse.json({ error: 'Riwaq could not complete the chat request' }, { status: 502 })
  }
}
