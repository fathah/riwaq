'use client'

import Link from 'next/link'
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type { Agent, ChatCitation, ChatResult } from '../lib/riwaq'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: ChatCitation[]
  model?: string
  usage?: ChatResult['usage']
  error?: boolean
}

const starters = [
  'What can you help me with?',
  'Summarize your knowledge in three points.',
  'What information do you need from me?',
]

function messageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function Playground({ agents }: { agents: Agent[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [conversationId, setConversationId] = useState<string>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const activeAgent = agents.find((agent) => agent.id === agentId)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, pending])

  function reset(nextAgentId = agentId) {
    setAgentId(nextAgentId)
    setConversationId(undefined)
    setMessages([])
    setInput('')
  }

  async function sendMessage(message: string) {
    const cleanMessage = message.trim()
    if (!cleanMessage || !agentId || pending) return

    setMessages((current) => [...current, { id: messageId(), role: 'user', content: cleanMessage }])
    setInput('')
    setPending(true)

    try {
      const response = await fetch('/api/playground/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, message: cleanMessage, ...(conversationId ? { conversationId } : {}) }),
      })
      const result = await response.json().catch(() => null) as (ChatResult & { error?: string }) | null
      if (!response.ok || !result) throw new Error(result?.error || 'Chat request failed')

      setConversationId(result.conversationId)
      setMessages((current) => [...current, {
        id: messageId(),
        role: 'assistant',
        content: result.answer,
        citations: result.citations,
        model: result.model,
        usage: result.usage,
      }])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Chat request failed'
      setMessages((current) => [...current, { id: messageId(), role: 'assistant', content: message, error: true }])
      toast.error(message)
    } finally {
      setPending(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void sendMessage(input)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  if (agents.length === 0) {
    return (
      <section className="playground-panel playground-empty">
        <span className="playground-orb">✦</span>
        <h3>Create an agent first</h3>
        <p>The Playground needs an agent to receive and answer messages.</p>
        <Link className="button button-primary" href="/agents">Go to agents</Link>
      </section>
    )
  }

  return (
    <section className="playground-panel">
      <header className="playground-toolbar">
        <label>
          <span>Chat with</span>
          <select aria-label="Agent" disabled={pending} onChange={(event) => reset(event.target.value)} value={agentId}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <div className="playground-agent-meta">
          <span className="status-dot" />
          <span>{activeAgent?.model || 'Organization model'}</span>
        </div>
        <button className="button button-secondary" disabled={pending || messages.length === 0} onClick={() => reset()} type="button">New conversation</button>
      </header>

      <div aria-live="polite" className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <span className="playground-orb">{activeAgent?.name.slice(0, 1).toUpperCase()}</span>
            <h3>Start a conversation with {activeAgent?.name}</h3>
            <p>Messages use this agent’s prompt, model, memory, and connected knowledge.</p>
            <div className="starter-grid">
              {starters.map((starter) => <button key={starter} onClick={() => void sendMessage(starter)} type="button">{starter}</button>)}
            </div>
          </div>
        ) : messages.map((message) => (
          <article className={`message-row message-${message.role}`} key={message.id}>
            <div className="message-avatar">{message.role === 'assistant' ? activeAgent?.name.slice(0, 1).toUpperCase() : 'You'}</div>
            <div className="message-content">
              <div className={`message-bubble${message.error ? ' message-bubble-error' : ''}`}>{message.content}</div>
              {!!message.citations?.length && (
                <div className="citation-list">
                  {message.citations.map((citation) => (
                    <span key={citation.chunkId} title={`${citation.kbName} · ${Math.round(citation.similarity * 100)}% match`}>
                      {citation.documentName} <small>{Math.round(citation.similarity * 100)}%</small>
                    </span>
                  ))}
                </div>
              )}
              {message.usage && <small className="message-meta">{message.model} · {message.usage.inputTokens} input + {message.usage.outputTokens} output tokens</small>}
            </div>
          </article>
        ))}
        {pending && (
          <article className="message-row message-assistant">
            <div className="message-avatar">{activeAgent?.name.slice(0, 1).toUpperCase()}</div>
            <div className="typing-indicator" aria-label="Agent is responding"><span /><span /><span /></div>
          </article>
        )}
      </div>

      <form className="chat-composer" onSubmit={submit}>
        <textarea aria-label="Message" disabled={pending} maxLength={20_000} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder={`Message ${activeAgent?.name}…`} rows={2} value={input} />
        <button aria-label="Send message" className="send-button" disabled={pending || !input.trim()} type="submit">Send <span>↗</span></button>
        <small>Enter to send · Shift + Enter for a new line</small>
      </form>
    </section>
  )
}
