export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Riwaq API',
    version: '1.0.0',
    description: 'Multi-tenant RAG, memory, analytics, and OpenAI-compatible chat API.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      orgApiKey: { type: 'http', scheme: 'bearer' },
      endUserToken: { type: 'apiKey', in: 'header', name: 'X-End-User-Token' },
    },
    schemas: {
      Error: { type: 'object', required: ['error'], properties: { error: {} } },
      NativeChatRequest: {
        type: 'object', required: ['message'],
        properties: { conversationId: { type: 'string', format: 'uuid' }, endUserId: { type: 'string' }, message: { type: 'string', minLength: 1 } },
      },
      NativeChatResult: {
        type: 'object', required: ['conversationId', 'answer', 'citations', 'model', 'usage', 'finishReason'],
        properties: {
          conversationId: { type: 'string', format: 'uuid' }, answer: { type: 'string' },
          citations: { type: 'array', items: { type: 'object' } }, model: { type: 'string' },
          usage: { type: 'object' }, finishReason: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/health': { get: { summary: 'Liveness and database health', responses: { '200': { description: 'Healthy' }, '503': { description: 'Unavailable' } } } },
    '/ready': { get: { summary: 'Database and queue dependency readiness', responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } } } },
    '/organizations': { post: { summary: 'Provision an organization', responses: { '201': { description: 'Created' }, '401': { description: 'Admin token required' } } } },
    '/organizations/usage': { get: { summary: 'Current persistent usage and configured ceilings', security: [{ orgApiKey: [] }], responses: { '200': { description: 'Usage snapshot' } } } },
    '/agents/{id}/chat': {
      post: {
        summary: 'Run the canonical Riwaq chat pipeline',
        security: [{ orgApiKey: [], endUserToken: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NativeChatRequest' } } } },
        responses: { '200': { description: 'Canonical chat result', content: { 'application/json': { schema: { $ref: '#/components/schemas/NativeChatResult' } } } }, '401': { description: 'Authentication failed' }, '429': { description: 'Rate or quota exceeded' } },
      },
    },
    '/v1/chat/completions': {
      post: { summary: 'OpenAI-compatible chat completions', security: [{ orgApiKey: [], endUserToken: [] }], responses: { '200': { description: 'OpenAI chat completion or SSE stream' }, '429': { description: 'Rate or quota exceeded' } } },
    },
    '/v1/models': { get: { summary: 'List agents as OpenAI models', security: [{ orgApiKey: [] }], responses: { '200': { description: 'Model list' } } } },
  },
} as const
