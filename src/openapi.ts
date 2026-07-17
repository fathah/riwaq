// Hand-maintained OpenAPI 3.1 description of the Riwaq HTTP surface. Kept in sync
// with the routes; served at GET /openapi.json. Bodies/queries are validated with
// zod at the route layer — this document is the published contract.

const agentIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'Agent id',
} as const

const pageParams = [
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
  { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
] as const

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Riwaq API',
    version: '1.4.0',
    description:
      'Multi-tenant AI agent infrastructure: RAG + per-agent memory + question analytics, ' +
      'a per-org self-learning loop, scheduled reminders with signed webhooks, and an ' +
      'OpenAI-compatible chat surface. Isolation by default; sharing by opt-in.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Organizations' },
    { name: 'Admin' },
    { name: 'Agents' },
    { name: 'Memory' },
    { name: 'Knowledge' },
    { name: 'Chat' },
    { name: 'OpenAI-compatible' },
    { name: 'Analytics' },
    { name: 'Self-learning' },
    { name: 'Reminders' },
    { name: 'Channels' },
    { name: 'Ops' },
  ],
  components: {
    securitySchemes: {
      orgApiKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'Organization API key from POST /organizations (Authorization: Bearer <key>).',
      },
      endUserToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-End-User-Token',
        description: 'Short-lived HMAC token signed by the org backend; required for chat in production.',
      },
      adminToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Admin-Token',
        description: 'Deployment admin token. Required for organization management.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { description: 'String message, or a validation-issue object.' } },
      },
      OpenAIError: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: ['string', 'null'] } },
          },
        },
      },
      Citation: {
        type: 'object',
        properties: {
          chunkId: { type: 'string', format: 'uuid' },
          documentId: { type: 'string', format: 'uuid' },
          documentName: { type: 'string' },
          knowledgeBaseId: { type: 'string', format: 'uuid' },
          kbName: { type: 'string' },
          similarity: { type: 'number' },
        },
      },
      NativeChatRequest: {
        type: 'object',
        required: ['message'],
        properties: {
          conversationId: { type: 'string', format: 'uuid', description: 'Resume an existing conversation.' },
          endUserId: { type: 'string', description: 'Required unless supplied by X-End-User-Token; ignored in production.' },
          message: { type: 'string', minLength: 1 },
        },
      },
      NativeChatResult: {
        type: 'object',
        required: ['conversationId', 'answer', 'citations', 'model', 'usage', 'finishReason'],
        properties: {
          conversationId: { type: 'string', format: 'uuid' },
          answer: { type: 'string' },
          citations: { type: 'array', items: { $ref: '#/components/schemas/Citation' } },
          model: { type: 'string' },
          usage: {
            type: 'object',
            properties: { inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' } },
          },
          finishReason: { type: 'string', enum: ['stop', 'length', 'tool_use', 'content_filter', 'other'] },
        },
      },
      CreateAgentRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          systemPrompt: { type: 'string' },
          provider: { type: 'string', enum: ['anthropic', 'openai'] },
          model: { type: 'string' },
        },
      },
      UpdateAgentRequest: {
        type: 'object',
        required: ['systemPrompt'],
        properties: {
          systemPrompt: { type: 'string', maxLength: 20000, description: 'Operator instructions. Send an empty string to restore Riwaq defaults.' },
        },
      },
      Memory: {
        type: 'object',
        required: ['id', 'endUserId', 'fact', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          endUserId: { type: ['string', 'null'], description: 'Null means agent-wide; otherwise isolated to this end-user identity.' },
          fact: { type: 'string', maxLength: 1000 },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      LearningReport: {
        type: 'object',
        properties: {
          coverage: {
            type: 'object',
            properties: {
              totalQuestions: { type: 'integer' },
              answered: { type: 'integer' },
              unanswered: { type: 'integer' },
              answerRate: { type: ['number', 'null'] },
            },
          },
          gaps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { topic: { type: 'string' }, count: { type: 'integer' }, avgSimilarity: { type: 'number' } },
            },
          },
          learned: {
            type: 'object',
            properties: {
              pending: { type: 'integer' },
              approved: { type: 'integer' },
              rejected: { type: 'integer' },
            },
          },
        },
      },
      LearnedAnswer: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          question: { type: 'string' },
          answer: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          distinctUserCount: { type: 'integer' },
          promotedDocumentId: { type: ['string', 'null'], format: 'uuid' },
        },
      },
      CreateReminderRequest: {
        type: 'object',
        required: ['title', 'dueAt'],
        description: 'Provide either `message` (static) or `prompt` (agent composes at fire time).',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          message: { type: 'string', maxLength: 4000 },
          prompt: { type: 'string', maxLength: 4000 },
          dueAt: { type: 'string', format: 'date-time', description: 'Must be in the future.' },
          recurrence: { type: ['string', 'null'], enum: ['daily', 'weekly', 'monthly', 'yearly', null] },
          endUserId: { type: 'string' },
        },
      },
      Reminder: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          agentId: { type: 'string', format: 'uuid' },
          endUserId: { type: ['string', 'null'] },
          title: { type: 'string' },
          message: { type: ['string', 'null'] },
          prompt: { type: ['string', 'null'] },
          dueAt: { type: 'string', format: 'date-time' },
          recurrence: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['scheduled', 'firing', 'completed', 'error', 'cancelled'] },
          source: { type: 'string', enum: ['api', 'auto'] },
          nextFireAt: { type: 'string', format: 'date-time' },
          fireCount: { type: 'integer' },
          lastFiredAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ReminderDelivery: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          reminderId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['ok', 'failed', 'skipped'] },
          responseCode: { type: ['integer', 'null'] },
          error: { type: ['string', 'null'] },
          firedAt: { type: 'string', format: 'date-time' },
        },
      },
      AgentChannel: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          agentId: { type: 'string', format: 'uuid' },
          provider: { type: 'string', enum: ['telegram'] },
          displayName: { type: 'string' },
          externalUsername: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['connecting', 'active', 'error'] },
          lastError: { type: ['string', 'null'] },
          lastReceivedAt: { type: ['string', 'null'], format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    // --- Ops ---
    '/health': {
      get: { tags: ['Ops'], summary: 'Liveness and database health', responses: { '200': { description: 'Healthy' }, '503': { description: 'Unavailable' } } },
    },
    '/ready': {
      get: { tags: ['Ops'], summary: 'Database and queue dependency readiness', responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } } },
    },
    '/metrics': {
      get: { tags: ['Ops'], summary: 'Prometheus metrics (admin-token protected)', responses: { '200': { description: 'Metrics text' }, '404': { description: 'Not found (bad/absent admin token)' } } },
    },
    '/openapi.json': {
      get: { tags: ['Ops'], summary: 'This document', responses: { '200': { description: 'OpenAPI 3.1 document' } } },
    },

    // --- Organizations ---
    '/organizations': {
      post: {
        tags: ['Organizations'],
        summary: 'Provision an organization (public; admin-token gated when ADMIN_TOKEN is set)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 } } } } } },
        responses: { '201': { description: 'Created — returns apiKey ONCE' }, '401': { description: 'Admin token required' }, '429': { description: 'Signup rate limited' } },
      },
    },
    '/organizations/me': {
      get: { tags: ['Organizations'], summary: 'Current org + LLM config (key masked)', security: [{ orgApiKey: [] }], responses: { '200': { description: 'Org' } } },
    },
    '/organizations/usage': {
      get: { tags: ['Organizations'], summary: 'Persistent usage + live storage counts and ceilings', security: [{ orgApiKey: [] }], responses: { '200': { description: 'Usage snapshot' } } },
    },
    '/admin/organizations': {
      get: {
        tags: ['Admin'],
        summary: 'List organizations without exposing API-key hashes or credentials',
        security: [{ adminToken: [] }],
        responses: { '200': { description: 'Organizations' }, '401': { description: 'Valid admin token required' } },
      },
    },
    '/admin/organizations/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Rename an organization without rotating its API key',
        security: [{ adminToken: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 } } } } } },
        responses: { '200': { description: 'Renamed organization' }, '401': { description: 'Valid admin token required' }, '404': { description: 'Organization not found' } },
      },
    },
    '/organizations/llm': {
      put: {
        tags: ['Organizations'],
        summary: 'Set org LLM config (null clears a field → falls back to .env)',
        security: [{ orgApiKey: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { provider: { type: ['string', 'null'], enum: ['anthropic', 'openai', null] }, baseUrl: { type: ['string', 'null'], format: 'uri' }, apiKey: { type: ['string', 'null'] }, model: { type: ['string', 'null'] } } } } } },
        responses: { '200': { description: 'Updated (key masked)' }, '400': { description: 'Invalid / SSRF-rejected baseUrl' } },
      },
    },
    '/organizations/learning': {
      put: {
        tags: ['Self-learning'],
        summary: 'Set the distinct-user auto-promotion threshold (0 = operator approval only)',
        security: [{ orgApiKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['autoPromoteThreshold'], properties: { autoPromoteThreshold: { type: 'integer', minimum: 0 } } } } } },
        responses: { '200': { description: 'Updated' } },
      },
    },
    '/organizations/webhook': {
      put: {
        tags: ['Reminders'],
        summary: 'Set the signed reminder webhook (returns the signing secret ONCE); url:null disables',
        security: [{ orgApiKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: ['string', 'null'], format: 'uri' }, secret: { type: 'string', minLength: 16, maxLength: 200 } } } } } },
        responses: { '200': { description: 'Updated' }, '400': { description: 'Invalid / SSRF-rejected url' } },
      },
    },

    // --- Agents ---
    '/agents': {
      get: {
        tags: ['Agents'],
        summary: "List the org's agents (paginated)",
        security: [{ orgApiKey: [] }],
        parameters: [...pageParams],
        responses: { '200': { description: 'Agents' } },
      },
      post: {
        tags: ['Agents'],
        summary: 'Create an agent (auto-creates its private KB)',
        security: [{ orgApiKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateAgentRequest' } } } },
        responses: { '201': { description: 'Created — { agent, privateKbId }' } },
      },
    },
    '/agents/{id}': {
      get: { tags: ['Agents'], summary: 'Agent + linked KBs + effectiveLlm', security: [{ orgApiKey: [] }], parameters: [agentIdParam], responses: { '200': { description: 'Agent' }, '404': { description: 'Not found' } } },
      patch: {
        tags: ['Agents'],
        summary: 'Update an agent’s operator instructions',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateAgentRequest' } } } },
        responses: { '200': { description: 'Updated agent' }, '400': { description: 'Invalid instructions' }, '404': { description: 'Agent not found' } },
      },
    },
    '/agents/{id}/memories': {
      get: {
        tags: ['Memory'],
        summary: 'List an agent’s long-term memories without embedding vectors',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam, ...pageParams],
        responses: { '200': { description: 'Memories', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Memory' } } } } }, '404': { description: 'Agent not found' } },
      },
      post: {
        tags: ['Memory'],
        summary: 'Add an agent-wide or end-user memory and generate its embedding',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fact'], properties: { fact: { type: 'string', minLength: 1, maxLength: 1000 }, endUserId: { type: ['string', 'null'], maxLength: 500 } } } } } },
        responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Memory' } } } }, '400': { description: 'Invalid memory' }, '404': { description: 'Agent not found' } },
      },
      delete: {
        tags: ['Memory'],
        summary: 'Forget every memory for one end user',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam, { name: 'endUserId', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } }],
        responses: { '200': { description: 'Deleted count' }, '400': { description: 'Missing endUserId' }, '404': { description: 'Agent not found' } },
      },
    },
    '/agents/{id}/memories/{memoryId}': {
      patch: {
        tags: ['Memory'],
        summary: 'Edit a memory and regenerate its embedding',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam, { name: 'memoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fact'], properties: { fact: { type: 'string', minLength: 1, maxLength: 1000 } } } } } },
        responses: { '200': { description: 'Updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Memory' } } } }, '404': { description: 'Memory not found' } },
      },
      delete: {
        tags: ['Memory'],
        summary: 'Delete one memory',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam, { name: 'memoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Deleted' }, '404': { description: 'Memory not found' } },
      },
    },

    // --- Messaging channels ---
    '/channels': {
      get: { tags: ['Channels'], summary: "List the organization's messaging connections (credentials omitted)", security: [{ orgApiKey: [] }], responses: { '200': { description: 'Channels', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AgentChannel' } } } } } } },
    },
    '/agents/{id}/channels': {
      get: { tags: ['Channels'], summary: "List an agent's messaging connections", security: [{ orgApiKey: [] }], parameters: [agentIdParam], responses: { '200': { description: 'Channels' }, '404': { description: 'Agent not found' } } },
    },
    '/agents/{id}/channels/telegram': {
      post: {
        tags: ['Channels'],
        summary: 'Verify a Telegram bot token and connect it through outbound polling',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string', writeOnly: true } } } } } },
        responses: { '201': { description: 'Connected; token omitted from response' }, '400': { description: 'Invalid token' }, '409': { description: 'Agent or bot is already connected' }, '502': { description: 'Telegram polling setup failed' } },
      },
    },
    '/agents/{id}/channels/{channelId}': {
      delete: { tags: ['Channels'], summary: 'Stop polling and remove a messaging connection', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Disconnected' }, '404': { description: 'Channel not found' } } },
    },

    // --- Knowledge bases + documents ---
    '/knowledge-bases': {
      post: { tags: ['Knowledge'], summary: 'Create an organization-wide shared KB', security: [{ orgApiKey: [] }], responses: { '201': { description: 'Created and readable by every organization agent' } } },
      get: { tags: ['Knowledge'], summary: "List the org's KBs (paginated)", security: [{ orgApiKey: [] }], parameters: [...pageParams], responses: { '200': { description: 'KBs' } } },
    },
    '/agents/{id}/knowledge-bases': {
      get: { tags: ['Knowledge'], summary: 'KBs an agent can read (private + shared)', security: [{ orgApiKey: [] }], parameters: [agentIdParam], responses: { '200': { description: 'KBs' } } },
      post: {
        tags: ['Knowledge'],
        summary: 'Record a legacy shared-KB association',
        description: 'Shared KBs are already readable by every agent in the organization; this compatibility endpoint only records association metadata.',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['knowledgeBaseId'], properties: { knowledgeBaseId: { type: 'string', format: 'uuid' } } } } } },
        responses: { '201': { description: 'Linked' }, '400': { description: 'Cannot link a private KB' }, '404': { description: 'Not found' } },
      },
    },
    '/agents/{id}/knowledge-bases/{kbId}': {
      delete: { tags: ['Knowledge'], summary: 'Remove legacy association metadata', description: 'Does not revoke organization-wide access to a shared KB. Private KB associations cannot be removed.', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'kbId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Association metadata removed' }, '400': { description: 'Refused (private KB)' } } },
    },
    '/knowledge-bases/{kbId}/documents': {
      post: {
        tags: ['Knowledge'],
        summary: 'Upload a document (multipart file, or JSON { text, name }) → async ingest',
        security: [{ orgApiKey: [] }],
        parameters: [{ name: 'kbId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, name: { type: 'string' } } } }, 'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, name: { type: 'string' } } } } } },
        responses: { '202': { description: 'Accepted (processing)' }, '413': { description: 'Too large' }, '429': { description: 'Storage quota exceeded' } },
      },
      get: { tags: ['Knowledge'], summary: 'List documents in a KB (paginated)', security: [{ orgApiKey: [] }], parameters: [{ name: 'kbId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, ...pageParams], responses: { '200': { description: 'Documents' } } },
    },
    '/agents/{id}/documents': {
      post: { tags: ['Knowledge'], summary: "Convenience: upload into the agent's private KB", security: [{ orgApiKey: [] }], parameters: [agentIdParam], responses: { '202': { description: 'Accepted' } } },
    },
    '/knowledge-bases/{kbId}/documents/{docId}': {
      get: { tags: ['Knowledge'], summary: 'Inspect a document and its indexed text chunks', security: [{ orgApiKey: [] }], parameters: [{ name: 'kbId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, ...pageParams], responses: { '200': { description: 'Document and indexed chunks' }, '404': { description: 'Not found' } } },
      delete: { tags: ['Knowledge'], summary: 'Delete a document (cascades to chunks)', security: [{ orgApiKey: [] }], parameters: [{ name: 'kbId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found' } } },
    },

    // --- Chat ---
    '/agents/{id}/chat': {
      post: {
        tags: ['Chat'],
        summary: 'Run the canonical Riwaq chat pipeline',
        description: 'Add ?stream=1 for SSE (meta → token → done); add ?format=openai for the OpenAI projection.',
        security: [{ orgApiKey: [], endUserToken: [] }],
        parameters: [
          agentIdParam,
          { name: 'stream', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
          { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['native', 'openai'] } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NativeChatRequest' } } } },
        responses: {
          '200': { description: 'Canonical chat result (or SSE stream)', content: { 'application/json': { schema: { $ref: '#/components/schemas/NativeChatResult' } } } },
          '401': { description: 'Authentication failed' },
          '403': { description: 'Conversation belongs to another end user' },
          '404': { description: 'Agent or conversation not found' },
          '429': { description: 'Rate or quota exceeded' },
        },
      },
    },
    '/messages/{id}/feedback': {
      post: {
        tags: ['Chat'],
        summary: 'Rate an assistant message (up feeds the self-learning loop; down flags a gap)',
        security: [{ orgApiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['rating'], properties: { rating: { type: 'string', enum: ['up', 'down'] } } } } } },
        responses: { '200': { description: 'Recorded' }, '404': { description: 'Message not found' } },
      },
    },

    // --- Analytics + self-learning ---
    '/agents/{id}/analytics/top-questions': {
      get: { tags: ['Analytics'], summary: 'Most-asked topics (auto-clustered)', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } }], responses: { '200': { description: 'Topics' } } },
    },
    '/agents/{id}/analytics/learning': {
      get: { tags: ['Self-learning'], summary: 'Knowledge gaps, answer coverage, learned-answer pipeline', security: [{ orgApiKey: [] }], parameters: [agentIdParam], responses: { '200': { description: 'Learning report', content: { 'application/json': { schema: { $ref: '#/components/schemas/LearningReport' } } } } } },
    },
    '/agents/{id}/learned-answers': {
      get: {
        tags: ['Self-learning'],
        summary: 'List learned-answer candidates (optionally by status)',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam, { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'approved', 'rejected'] } }, ...pageParams],
        responses: { '200': { description: 'Candidates', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/LearnedAnswer' } } } } } },
      },
    },
    '/agents/{id}/learned-answers/{laId}/approve': {
      post: { tags: ['Self-learning'], summary: 'Operator approval → promote into the KB', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'laId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Promoted' }, '404': { description: 'No pending candidate' } } },
    },
    '/agents/{id}/learned-answers/{laId}/reject': {
      post: { tags: ['Self-learning'], summary: 'Operator rejection (never re-clustered)', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'laId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Rejected' }, '404': { description: 'No pending candidate' } } },
    },

    // --- Reminders ---
    '/agents/{id}/reminders': {
      post: {
        tags: ['Reminders'],
        summary: 'Schedule a reminder (fires a signed webhook at due time)',
        security: [{ orgApiKey: [] }],
        parameters: [agentIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateReminderRequest' } } } },
        responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Reminder' } } } }, '400': { description: 'Invalid (past dueAt, or no message/prompt)' }, '404': { description: 'Agent not found' } },
      },
      get: { tags: ['Reminders'], summary: 'List reminders (optionally by status)', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['scheduled', 'firing', 'completed', 'error', 'cancelled'] } }, ...pageParams], responses: { '200': { description: 'Reminders', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Reminder' } } } } } } },
    },
    '/agents/{id}/reminders/{rid}': {
      get: { tags: ['Reminders'], summary: 'Get one reminder', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'rid', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Reminder' }, '404': { description: 'Not found' } } },
      delete: { tags: ['Reminders'], summary: 'Cancel a reminder', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'rid', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Cancelled' }, '404': { description: 'No cancellable reminder' } } },
    },
    '/agents/{id}/reminders/{rid}/deliveries': {
      get: { tags: ['Reminders'], summary: 'Delivery audit trail for a reminder', security: [{ orgApiKey: [] }], parameters: [agentIdParam, { name: 'rid', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, ...pageParams], responses: { '200': { description: 'Deliveries', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ReminderDelivery' } } } } } } },
    },

    // --- OpenAI-compatible ---
    '/v1/chat/completions': {
      post: {
        tags: ['OpenAI-compatible'],
        summary: 'OpenAI-compatible chat completions',
        description: 'model = agent id or name. Client system messages are ignored; history is client-owned. stream:true emits chat.completion.chunk frames ending in [DONE].',
        security: [{ orgApiKey: [], endUserToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['model', 'messages'], properties: { model: { type: 'string' }, messages: { type: 'array' }, stream: { type: 'boolean' }, user: { type: 'string' }, max_tokens: { type: 'integer' }, max_completion_tokens: { type: 'integer' }, temperature: { type: 'number' }, stream_options: { type: 'object' } } } } } },
        responses: {
          '200': { description: 'chat.completion (or SSE stream)' },
          '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenAIError' } } } },
          '404': { description: 'model_not_found', content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenAIError' } } } },
          '429': { description: 'Rate or quota exceeded' },
        },
      },
    },
    '/v1/models': {
      get: { tags: ['OpenAI-compatible'], summary: "List the org's agents as OpenAI models", security: [{ orgApiKey: [] }], parameters: [...pageParams], responses: { '200': { description: 'Model list' } } },
    },
  },
} as const
