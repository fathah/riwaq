'use client'

import { useFormStatus } from 'react-dom'
import { connectTelegramAction, disconnectChannelAction } from '../app/actions'
import type { Agent, AgentChannel } from '../lib/riwaq'
import { Modal } from './modal'

function Submit({ label, pendingLabel = 'Saving…' }: { label: string; pendingLabel?: string }) {
  const { pending } = useFormStatus()
  return <button className="button button-primary" disabled={pending} type="submit">{pending ? pendingLabel : label}</button>
}

export function AgentChannelModal({ agent, channel }: { agent: Agent; channel?: AgentChannel }) {
  if (channel) {
    const botName = channel.externalUsername ? `@${channel.externalUsername}` : channel.displayName
    return (
      <Modal tone="secondary" trigger={botName} title="Telegram bot" description={`Connected to ${agent.name}. Messages use this agent’s knowledge, memory, and learning pipeline.`}>
        <div className="channel-summary">
          <div><span>Bot</span><strong>{botName}</strong></div>
          <div><span>Status</span><strong>{channel.status === 'active' ? 'Connected' : channel.status}</strong></div>
          <div><span>Last message</span><strong>{channel.lastReceivedAt ? new Date(channel.lastReceivedAt).toLocaleString() : 'No messages yet'}</strong></div>
          {channel.lastError ? <p className="channel-error">{channel.lastError}</p> : null}
        </div>
        <form action={disconnectChannelAction} className="modal-form channel-disconnect-form">
          <input name="agentId" type="hidden" value={agent.id} />
          <input name="channelId" type="hidden" value={channel.id} />
          <footer className="modal-actions"><span>This stops polling and forgets the bot token.</span><Submit label="Disconnect" pendingLabel="Disconnecting…" /></footer>
        </form>
      </Modal>
    )
  }

  return (
    <Modal tone="secondary" trigger="Connect Telegram" title="Connect Telegram" description={`Attach a Telegram bot to ${agent.name}.`}>
      <form action={connectTelegramAction} className="modal-form">
        <input name="agentId" type="hidden" value={agent.id} />
        <ol className="channel-steps">
          <li>Open <strong>@BotFather</strong> in Telegram.</li>
          <li>Run <code>/newbot</code> and copy the bot token.</li>
          <li>Paste only that token below.</li>
        </ol>
        <label>
          <span>Bot token</span>
          <input name="token" type="password" required autoComplete="new-password" placeholder="123456789:AA…" />
          <small>The token stays on the Riwaq server and is encrypted at rest in production.</small>
        </label>
        <footer className="modal-actions"><span>Works from localhost or Docker—no public URL required.</span><Submit label="Connect bot" pendingLabel="Connecting…" /></footer>
      </form>
    </Modal>
  )
}
