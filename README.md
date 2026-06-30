# riwaq

Multi-tenant AI agent infrastructure — **RAG + per-agent memory + question analytics**,
with an **OpenAI-compatible API** built in. One backend hosts many organizations, each
with many independent agents. Every agent has its own private knowledge base and can
optionally **share** knowledge bases with other agents in the same org.

Docker-first, API-first. The full design lives in [plan.md](plan.md).

---

## What it does

A business creates an **agent**, uploads **knowledge**, and end-users chat with it. Each
turn runs one pipeline:

```
message ─▶ embed ─▶ KB search (private + shared) + memory recall ─▶ build prompt ─▶ Claude ─▶ answer
                                                                                       │
                                                       persist + learn (async) ────────┘
```

The async learning loop, after each response: extracts durable **memories**, clusters the
question into a **topic** (powering "most asked"), and stores which chunks were used.

**Isolation by default, sharing by opt-in:**

| Always isolated per agent | Shareable within an org (opt-in) |
|---|---|
| memory, conversations, messages, topics, analytics, feedback | knowledge bases |

Nothing ever crosses an organization boundary.

---

## Quick start

```bash
cp .env.example .env
# set ANTHROPIC_API_KEY and EMBEDDINGS_API_KEY (Voyage AI) in .env
docker compose up --build
```

The API boots at `http://localhost:3000`, runs migrations automatically (including the
pgvector `vector` extension), and is ready when you see `listening on ...`.

```bash
curl localhost:3000/health      # {"ok":true}
```

> The Postgres container publishes on host port **5433** (to avoid clashing with a local
> Postgres on 5432). The API talks to the DB over the compose network, so this only
> matters if you connect host tools to the database directly.

---

## Authentication

- `POST /organizations` is **public** and returns an **API key once** — store it.
- Every other endpoint requires `Authorization: Bearer <key>`. The key resolves to a
  single org, and all queries are scoped to it, so tenants can't see each other's data.

---

## Walkthrough

```bash
B=http://localhost:3000

# 1. Create an org — save the apiKey it returns
curl -sX POST $B/organizations -H 'content-type: application/json' -d '{"name":"Acme"}'
KEY=riwaq_...        # from the response

# 2. Create an agent (auto-creates its private KB)
curl -sX POST $B/agents -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Support Bot","systemPrompt":"You are Acme support."}'
AGENT=...            # agent.id from the response

# 3. Add knowledge to the agent's private KB (text…)
curl -sX POST $B/agents/$AGENT/documents -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"refunds","text":"Refunds are available within 30 days of purchase."}'

#    …or upload a file (pdf / txt / md):
curl -sX POST $B/agents/$AGENT/documents -H "authorization: Bearer $KEY" -F file=@handbook.pdf

# 4. Chat
curl -sX POST $B/agents/$AGENT/chat -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"endUserId":"u_123","message":"What is the refund window?"}'
# → { "answer": "...", "citations": [...], "conversationId": "..." }
#   add ?stream=1 for SSE (events: meta → token → done)

# 5. Feedback on an assistant message
curl -sX POST $B/messages/<messageId>/feedback -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"rating":"up"}'

# 6. Analytics — most-asked topics, auto-clustered
curl -s $B/agents/$AGENT/analytics/top-questions -H "authorization: Bearer $KEY"
```

### Shared knowledge bases

```bash
# Create a shared KB at the org level, add docs, link it to one or more agents
KB=$(curl -sX POST $B/knowledge-bases -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"name":"Company Policies"}' | jq -r .id)

curl -sX POST $B/knowledge-bases/$KB/documents -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"name":"pto","text":"Employees get 25 PTO days."}'

curl -sX POST $B/agents/$AGENT/knowledge-bases -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d "{\"knowledgeBaseId\":\"$KB\"}"
```

Now `$AGENT` retrieves across **its private KB + the shared KB**. A shared KB can only be
linked to agents in the same org.

---

## OpenAI-compatible API

Point any OpenAI client at `http://localhost:3000/v1`, use your **org API key** as the
OpenAI key, and pass the **agent id or name** as `model`. The same RAG + memory +
analytics pipeline runs underneath.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="riwaq_...")

client.models.list()          # your agents, listed as models

resp = client.chat.completions.create(
    model="Support Bot",                       # agent id or name
    messages=[{"role": "user", "content": "What is the refund window?"}],
    user="u_123",                              # → endUserId for memory & analytics
)
print(resp.choices[0].message.content)
# resp.riwaq → { conversationId, citations } (non-standard extension; safely ignored by strict clients)
```

```bash
# streaming, raw HTTP
curl -sX POST $B/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$AGENT\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true}"
```

- **History is client-owned** — send the full `messages` array each call (OpenAI contract).
- **Client `system` messages are ignored** — the agent's own system prompt and grounding
  rules stay authoritative.
- **`stream: true`** emits standard `chat.completion.chunk` frames ending in `[DONE]`;
  set `stream_options.include_usage` for a usage frame.

Works out of the box with the `openai` SDKs, LangChain, OpenWebUI, LibreChat, and similar.

---

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/organizations` | **public**; returns `apiKey` once |
| GET | `/organizations/me` | current org |
| POST | `/agents` | auto-creates the agent's private KB |
| GET | `/agents/:id` | agent + linked KBs |
| POST | `/knowledge-bases` | create a shared KB |
| GET | `/knowledge-bases` | list the org's KBs |
| POST | `/agents/:id/knowledge-bases` | link a shared KB to an agent |
| GET | `/agents/:id/knowledge-bases` | KBs the agent can read |
| DELETE | `/agents/:id/knowledge-bases/:kbId` | unlink (never the private KB) |
| POST | `/knowledge-bases/:kbId/documents` | upload file or text → async ingest |
| POST | `/agents/:id/documents` | convenience: upload into the agent's private KB |
| GET | `/knowledge-bases/:kbId/documents` | list documents (with status) |
| DELETE | `/knowledge-bases/:kbId/documents/:docId` | delete (cascades to chunks) |
| POST | `/agents/:id/chat` | `{ endUserId, message, conversationId? }`; `?stream=1` for SSE |
| POST | `/messages/:id/feedback` | `{ rating: "up" \| "down" }` |
| GET | `/agents/:id/analytics/top-questions` | most-asked topics |
| POST | `/v1/chat/completions` | OpenAI-compatible; `model` = agent id/name; `stream` supported |
| GET | `/v1/models` | the org's agents, as OpenAI models |
| GET | `/health` | DB ping |

---

## Architecture

```
organization (tenant boundary, scoped by API key)
 ├── agent A ──── private KB A ─┐
 │                              ├──▶ agent retrieval = private KB + linked shared KBs
 │            ┌── shared KB X ──┘
 ├── agent B ─┤   (linked to A and B)
 │            └── private KB B
 └── agent C ──── private KB C
```

- **Knowledge bases are first-class.** Documents and chunks belong to a KB, not an agent;
  an agent reaches chunks via the `agent_knowledge_bases` link table. Retrieval resolves
  the agent's full KB set, then does a top-k cosine search filtered to it.
- **Memory** is per-agent (optionally per end-user): durable facts stored as text +
  embedding, recalled by relevance and injected into the prompt.
- **Topics** form automatically — each question is embedded and assigned to the nearest
  topic centroid, or seeds a new cluster. Counts + recency give "most asked" with no
  manual tagging.
- The **async learning loop** runs after the response is sent, so it never adds latency.

### Project layout

```
src/
├── index.ts            # Hono bootstrap, runs migrations, mounts routes
├── env.ts              # zod-validated environment
├── db/                 # schema, SQL migration (vector ext), client, ownership guards
├── lib/                # embeddings (Voyage), llm (Claude), chunk, parse
├── middleware/auth.ts  # API key → orgId
├── services/           # chat (shared pipeline), ingest, retrieve, memory, topics, learn
├── routes/             # organizations, agents, knowledge-bases, documents, chat, openai, feedback, analytics
└── prompts/            # system prompt + grounding rule, memory extraction, topic labels
```

---

## Stack

TypeScript · [Hono](https://hono.dev) · Postgres + [pgvector](https://github.com/pgvector/pgvector) ·
[Drizzle ORM](https://orm.drizzle.team) · Anthropic Claude (`claude-haiku-4-5-20251001`
default, per-agent override) · Voyage AI embeddings (`voyage-3`, 1024-d).

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | Postgres connection string (pgvector-enabled) |
| `ANTHROPIC_API_KEY` | for chat | Anthropic Claude key |
| `EMBEDDINGS_API_KEY` | for ingest/chat | Voyage AI key |
| `PORT` | no | HTTP port (default 3000) |

## Development

```bash
npm install
npm run dev        # tsx watch, hot reload
npm run typecheck  # tsc --noEmit
npm run migrate    # apply migrations standalone
```

## Status & roadmap

Working: tenancy + org auth, agents with auto private KB, shared KBs, ingestion
(pdf/txt/md), retrieval, native + OpenAI-compatible chat (with streaming), per-agent
memory, topic analytics, feedback.

Deferred (see [plan.md](plan.md) §11): finer KB access control (read-only shared KBs),
rate limiting/quotas, a durable job queue for ingestion, retrieval re-ranking, and
conversation summarization.
