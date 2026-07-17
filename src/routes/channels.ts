import { Hono } from 'hono'
import { z } from 'zod'
import { getAgentInOrg } from '../db/guards'
import { orgAuth } from '../middleware/auth'
import type { AppEnv } from '../types'
import {
  ChannelError,
  connectTelegramChannel,
  disconnectChannel,
  listChannels,
} from '../services/channels'

export const channelsRoute = new Hono<AppEnv>()
channelsRoute.use('/channels', orgAuth)
channelsRoute.use('/agents/*', orgAuth)

const tokenSchema = z.object({ token: z.string().min(1).max(200) })

channelsRoute.get('/channels', async (c) => c.json(await listChannels(c.get('orgId'))))

channelsRoute.get('/agents/:id/channels', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  return c.json(await listChannels(agent.orgId, agent.id))
})

channelsRoute.post('/agents/:id/channels/telegram', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  try {
    return c.json(await connectTelegramChannel({ orgId: agent.orgId, agentId: agent.id, token: parsed.data.token }), 201)
  } catch (error) {
    if (error instanceof ChannelError) return c.json({ error: error.message }, error.status as 400 | 409 | 502)
    throw error
  }
})

channelsRoute.delete('/agents/:id/channels/:channelId', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  try {
    return c.json(await disconnectChannel({
      orgId: agent.orgId,
      agentId: agent.id,
      channelId: c.req.param('channelId'),
    }))
  } catch (error) {
    if (error instanceof ChannelError) return c.json({ error: error.message }, error.status as 400 | 404)
    throw error
  }
})
