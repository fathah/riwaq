<p align="center">
<img src="./assets/riwaq.webp" width="50%"/>
</p>

Multi-tenant AI agent infrastructure. **RAG + per-agent memory + question analytics +
a per-org self-learning loop + scheduled reminders + messaging channels**. One backend hosts many
organizations, each with many independent agents. Every agent has its own private
knowledge base and can optionally **share** knowledge bases with other agents in the
same org.

Provider-agnostic on both sides:

- **Outbound** — each agent runs on Anthropic Claude **or any OpenAI-compatible endpoint**
  (OpenAI, OpenRouter, Groq, Together, local Ollama/vLLM/LM Studio…).
- **Inbound** — one canonical response contract (Riwaq's own), with a serializer that
  also speaks **OpenAI** (`/v1/chat/completions`, or `?format=openai`). The output shape
  is identical no matter which provider backs the agent, and stays stable as new
  backends/formats are added.
- **Channels** — connect a Telegram bot to any agent. Telegram uses the same RAG,
  per-user memory, analytics, quotas, and learning pipeline as the API and Playground.

Docker-first, API-first.

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
question into a **topic** (powering "most asked"), records the retrieval quality (for
gap detection), and — optionally — extracts **dated commitments** into reminders. None of
it adds latency to the answer.

Two features build on those signals:

- **Self-learning** — thumbs-up answers cluster into **learned answers**; once enough
  *distinct* end users endorse one (or an operator approves it) the Q&A is promoted into
  the agent's knowledge base, so it answers better over time. A **learning report**
  surfaces knowledge gaps ranked by how often they're asked. See [Self-learning](#self-learning).
- **Reminders** — agents remember dates (renewals, deadlines) and fire a **signed webhook**
  to your backend at due time; reminders can be created via API or auto-extracted from
  chat. See [Reminders](#reminders).

### Telegram bots

Open **Agents → Connect Telegram** in the console. Create a bot with `@BotFather`
and paste its raw token. Riwaq connects through outbound long polling, so it works
from localhost, Docker, private networks, and hosts behind NAT without a public URL,
TLS certificate, reverse proxy, or additional gateway service.

Every Telegram message enters the canonical agent chat service, so answers and
learning stay consistent with the Playground and HTTP API. A new Telegram contact is
auto-provisioned as `telegram:<user-id>`. It can later be linked to the business's
canonical customer ID from **Users** (or `POST /users/connect`), migrating memories
and reminders. Group participants do not share conversation history. `/new` starts a
fresh conversation.

Channel conversations also rotate automatically after **30 minutes of inactivity**
or **20 user turns**, whichever comes first. These defaults are configurable with
`CHANNEL_SESSION_IDLE_MINUTES` and `CHANNEL_SESSION_MAX_TURNS`. Rotation retains the
old transcript for history/audit while starting clean short-term model context;
canonical user memories and reminders continue across sessions.

The bot token is never returned by the API and is encrypted at rest when
`SECRET_ENCRYPTION_KEY` is configured. Telegram updates are deduplicated before
being handed to the durable channel worker. A PostgreSQL advisory lock ensures only
one Riwaq replica polls each bot. WhatsApp and other providers can be
added as adapters over the same `agent_channels` and canonical chat layer.

**Isolation by default, sharing by opt-in:**

| Always isolated per agent                                                        | Shareable within an org (opt-in) |
| -------------------------------------------------------------------------------- | -------------------------------- |
| memory, conversations, messages, topics, analytics, feedback, learned answers, reminders | knowledge bases                  |

Nothing ever crosses an organization boundary.

---

## Quick start

The easiest local setup builds the API and starts PostgreSQL, DragonflyDB, and the API
together:

```bash
cp .env.example .env
# Set an LLM: ANTHROPIC_API_KEY, or OPENAI_API_KEY + OPENAI_BASE_URL for any
# OpenAI-compatible endpoint (OpenAI, Groq, OpenRouter, Ollama…). Embeddings work
# out of the box with no key (offline local model); see "Embeddings" below.
docker compose up --build
```

The API boots at `http://localhost:3000`, runs migrations automatically (including the
pgvector `vector` extension), and is ready when you see `listening on ...`.

```bash
curl localhost:3000/health      # {"ok":true}
```

The optional Next.js management console is available at `http://localhost:3001`.
On first boot it shows the missing server-side environment values and walks you
through creating an organization, setting `RIWAQ_API_KEY`, and protecting the
console with `RIWAQ_DASHBOARD_TOKEN`.

For a production-style deployment using the published
`ghcr.io/fathah/rewaq:latest` image:

```bash
cp .env.production.example .env.production
# Replace every change-me value, then:
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
curl http://localhost:3000/ready
```

See [Docker and deployment](DOCKER.md) for Docker-only commands, configuration,
upgrades, logs, image tags, and GHCR publishing details.

> In the local development stack, Postgres publishes on host port **5433** (to avoid
> clashing with a local Postgres on 5432). The production stack does not publish its
> database or cache ports.

## Web dashboard

The dashboard in [`web/`](web/) is a separate Next.js App Router application. It
keeps the organization API key on the server and protects management actions with
an HTTP-only signed session.

It currently provides:

- route-based Overview, Agents, Users, Playground, Knowledge, Organizations, and Settings pages in one persistent sidebar;
- a server-proxied Playground for chatting with any agent in the active organization, including citations and token usage;
- API readiness, organization usage, token quota, and storage summaries;
- modal workflows for agent and shared knowledge-base creation;
- organization user management, external identity linking, and per-user memory editing across agents;
- modal organization LLM provider, model, endpoint, and key configuration;
- admin-token-protected organization listing, creation, rename, and workspace switching;
- toast feedback after successful or failed management actions.

For local development outside Docker:

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

If the environment values are missing or invalid, the console stays in setup mode
and does not expose management actions.

---

## Authentication

- `POST /organizations` returns an **API key once** — store it. It is admin-token
  protected when `ADMIN_TOKEN` is configured and rate-limited otherwise.
- Tenant endpoints require `Authorization: Bearer <key>`. The key resolves to a
  single org, and all queries are scoped to it, so tenants can't see each other's data.
- Admin organization endpoints require `X-Admin-Token`. The management console can
  combine it with a signed, server-selected
  organization ID to switch workspaces. These credentials never reach browser code.
- In production, chat also requires `X-End-User-Token`: a short-lived HMAC token signed
  by the organization's trusted backend. Its `{ sub, orgId, exp }` claims bind memory
  and conversation access to an authenticated end user; request-body `endUserId` is
  accepted only outside production.

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

# 2b. Connect an existing business customer to a platform identity (idempotent)
curl -sX POST $B/users/connect -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
    "userId":"customer_4821",
    "displayName":"Amina Rahman",
    "provider":"shopify",
    "namespace":"store_in",
    "externalUserId":"gid://shopify/Customer/42"
  }'

# 3. Add knowledge to the agent's private KB (text…)
curl -sX POST $B/agents/$AGENT/documents -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"refunds","text":"Refunds are available within 30 days of purchase."}'

#    …or upload a file (pdf / txt / md):
curl -sX POST $B/agents/$AGENT/documents -H "authorization: Bearer $KEY" -F file=@handbook.pdf

# 4. Chat
curl -sX POST $B/agents/$AGENT/chat -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -H "X-End-User-Token: $END_USER_TOKEN" \
  -d '{"endUserId":"u_123","message":"What is the refund window?"}'
# → { conversationId, answer, citations:[...], model, usage, finishReason }   (canonical shape)
#   add ?stream=1 for SSE (events: meta → token → done)
#   add ?format=openai to get the OpenAI chat.completion shape from this same endpoint

# 5. Feedback on an assistant message
curl -sX POST $B/messages/<messageId>/feedback -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"rating":"up"}'

# 6. Analytics — most-asked topics, auto-clustered
curl -s $B/agents/$AGENT/analytics/top-questions -H "authorization: Bearer $KEY"
```

### Choosing the LLM

The LLM config (`provider`, `model`, `baseURL`, `apiKey`) resolves through three layers —
each fills in what the one below leaves unset:

```
agent override  →  organization config  →  .env default
```

So an organization can **bring its own endpoint/key/model**, while the deployment-wide
`.env` provides the fallback. `provider` is `anthropic` (Claude) or `openai` (**any**
OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Together, Ollama, vLLM, LM Studio…).

**Per-organization** (most common — BYO key/endpoint):

```bash
curl -sX PUT $B/organizations/llm -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
    "provider":"openai",
    "baseUrl":"https://openrouter.ai/api/v1",
    "apiKey":"sk-or-...",
    "model":"openai/gpt-4o-mini"
  }'
# send a field as null to clear it (falls back to .env); GET /organizations/me shows
# the config with the key masked (hasApiKey: true)
```

**Per-agent override** (optional — a specific agent on a different model/provider):

```bash
curl -sX POST $B/agents -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Premium Bot","model":"claude-sonnet-4-6","provider":"anthropic"}'
```

`GET /agents/:id` returns `effectiveLlm` (the resolved provider/model/baseURL, key omitted).
Everything else — RAG, memory, analytics, the inbound API — works identically regardless
of provider.

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

## Embeddings

Pluggable, with an **offline fallback** so it runs with no API key:

| Provider | Set `EMBEDDINGS_PROVIDER` | Needs | Default model (dim) |
|---|---|---|---|
| **local** (default fallback) | `local` | nothing — in-process, offline | `all-MiniLM-L6-v2` (384) |
| **voyage** | `voyage` | `EMBEDDINGS_API_KEY` | `voyage-3` (1024) |
| **openai-compatible** | `openai` | `EMBEDDINGS_API_KEY` + `EMBEDDINGS_BASE_URL` | `text-embedding-3-small` |

If `EMBEDDINGS_PROVIDER` is unset: uses **voyage** when `EMBEDDINGS_API_KEY` is set,
otherwise the **local** offline model (one-time ~23 MB download, then cached). Docker
Compose persists that download in the `modelcache` volume. The
`openai` provider points at any `/v1/embeddings` server — OpenAI, a local Ollama, or
LM Studio.

> **Dimension is locked at first migration** via `EMBEDDING_DIM` (default 384, matching
> the local model). All providers must emit that dimension — OpenAI's `text-embedding-3-*`
> can via its `dimensions` param; Voyage needs `EMBEDDING_DIM=1024`. Changing it later
> means re-creating the vectors.

## Output formats

There is **one canonical result** internally; every wire format is a pure projection of
it (`src/serializers.ts`). The provider is normalized away *before* serialization, so a
Claude-backed and a GPT-backed agent return byte-identical structure.

```
provider (anthropic | openai | future) ─▶ canonical ChatResult ─▶ serializer ─▶ native | openai
```

- **Native** (default) — Riwaq's own shape: `{ conversationId, answer, citations, model, usage, finishReason }`.
  This is the stable, first-party contract you build against.
- **OpenAI** — request it two ways:
  - the dedicated endpoint `POST /v1/chat/completions` (OpenAI in, OpenAI out), or
  - `?format=openai` on the native endpoint (native in, OpenAI out).

Adding a new output format later = one branch in the serializer; the pipeline and the
canonical result don't change, so existing clients never break.

## OpenAI-compatible API (inbound)

> This is the **inbound** side — Riwaq _speaking_ the OpenAI protocol to clients. It's the
> OpenAI projection of the same canonical result, and is independent of which provider an
> agent uses _outbound_; a Claude-backed agent is still reachable here.

Point any OpenAI client at `http://localhost:3000/v1`, use your **org API key** as the
OpenAI key, and pass the **agent id or name** as `model`. The same RAG + memory +
analytics pipeline runs underneath.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="riwaq_...",
    default_headers={"X-End-User-Token": "<signed token>"},
)

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

## Self-learning

Each org's agents get better at answering their own users' questions over time — no model
training, just a feedback flywheel over signals the pipeline already emits.

- **Endorse** — an end-user thumbs-up feeds the learning loop. Equivalent questions
  cluster into a single **learned answer** candidate that counts *distinct* endorsing
  users (one vote per user, enforced in the DB — can't be inflated).
- **Promote** — a candidate becomes knowledge two ways:
  - **operator approval** (default), or
  - **auto-promotion** once distinct endorsements reach the org's threshold.
  Promotion writes the Q&A into the agent's KB as a `learned` document, so future
  retrieval surfaces the vetted answer. Fully reversible (delete the document).
- **Report** — knowledge gaps (questions the KB couldn't answer well) ranked by frequency,
  plus answer coverage and the candidate pipeline.

```bash
# Set the auto-promote threshold (distinct users). 0 = operator approval only.
curl -sX PUT $B/organizations/learning -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"autoPromoteThreshold":3}'

# Review pending candidates and approve one
curl -s "$B/agents/$AGENT/learned-answers?status=pending" -H "authorization: Bearer $KEY"
curl -sX POST $B/agents/$AGENT/learned-answers/<id>/approve -H "authorization: Bearer $KEY"

# What should we teach this agent next?
curl -s $B/agents/$AGENT/analytics/learning -H "authorization: Bearer $KEY"
# → { coverage:{answered,unanswered,answerRate}, gaps:[{topic,count,avgSimilarity}], learned:{pending,approved,rejected} }
```

End-user feedback is untrusted, so a candidate only becomes knowledge via the
distinct-user threshold or an operator — never a single actor.

---

## Reminders

Agents remember dates (renewals, deadlines, follow-ups) and fire a **signed webhook** to
your backend at due time, which your system turns into an email / SMS / push.

```bash
# 1. Configure the org webhook once — the signing secret is returned ONCE, store it
curl -sX PUT $B/organizations/webhook -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"url":"https://acme.example.com/riwaq-hook"}'
# → { webhook: { url, secret } }   (verify X-Riwaq-Signature with this secret)

# 2. Schedule a reminder — static message OR an agent-composed `prompt`
curl -sX POST $B/agents/$AGENT/reminders -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
    "title":"Acme plan renewal",
    "dueAt":"2027-03-03T09:00:00Z",
    "recurrence":"yearly",
    "prompt":"Write a friendly reminder that the Acme plan renews today.",
    "endUserId":"u_123"
  }'
```

- **Delivery** — an SSRF-guarded POST with `X-Riwaq-Signature: sha256=<hmac>` over
  `timestamp.body`; every attempt is logged (`GET /agents/:id/reminders/:rid/deliveries`).
- **Recurrence** — `daily | weekly | monthly | yearly` advances to the next occurrence;
  one-offs complete. Failed deliveries retry with backoff, then flip to `error`.
- **Auto-extraction** — when `REMINDER_AUTO_EXTRACT=1`, the learn loop detects dated
  commitments in chat ("renews March 3") and creates reminders (`source:"auto"`), guarded
  by future-date-only, a horizon cap, a per-user cap, and de-duplication.
- **Scheduler** — a DB poller (multi-node safe via `FOR UPDATE SKIP LOCKED`) that runs on
  every replica; no Redis required.

Webhook payload:

```json
{ "type":"reminder", "reminderId":"…", "agentId":"…", "endUserId":"u_123",
  "title":"Acme plan renewal", "message":"…", "dueAt":"…", "firedAt":"…",
  "recurrence":"yearly", "source":"api", "occurrence":1 }
```

---

## Endpoints

| Method | Path                                      | Notes                                                                             |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/organizations`                          | **public**; returns `apiKey` once                                                 |
| GET    | `/organizations/me`                       | current org + LLM config (key masked)                                             |
| GET    | `/organizations/usage`                    | persistent token/spend usage + live storage counts and ceilings                   |
| PUT    | `/organizations/llm`                      | set org LLM config `{ provider?, baseUrl?, apiKey?, model? }` (null clears)       |
| PUT    | `/organizations/learning`                 | set self-learning auto-promote threshold `{ autoPromoteThreshold }`               |
| PUT    | `/organizations/webhook`                  | set reminder webhook `{ url, secret? }`; returns signing secret once (null clears) |
| POST   | `/agents`                                 | `{ name, systemPrompt?, provider?, model? }`; auto-creates the agent's private KB |
| PATCH  | `/agents/:id`                             | update persistent agent instructions with `{ systemPrompt }`; empty clears custom instructions |
| GET    | `/agents/:id/memories`                    | list long-term memories without exposing embedding vectors |
| POST   | `/agents/:id/memories`                    | add `{ fact, endUserId? }`; omit/null identity for agent-wide memory |
| PATCH  | `/agents/:id/memories/:memoryId`          | edit a memory and regenerate its embedding |
| DELETE | `/agents/:id/memories/:memoryId`          | delete one memory |
| GET    | `/users`                                  | list canonical users in the organization |
| POST   | `/users/connect`                          | idempotently create/link `{ userId, provider?, namespace?, externalUserId?, mergeExisting? }` |
| GET    | `/users/:userId`                          | user profile and connected platform identities |
| PATCH  | `/users/:userId`                          | update `{ displayName }` |
| GET    | `/users/:userId/memories`                 | user-specific memories across all agents |
| DELETE | `/users/:userId/identities/:identityId`   | disconnect one platform mapping without deleting user state |
| GET    | `/agents`                                 | list the organization's agents (paginated)                                       |
| GET    | `/agents/:id`                             | agent + linked KBs                                                                |
| POST   | `/knowledge-bases`                        | create a shared KB                                                                |
| GET    | `/knowledge-bases`                        | list the org's KBs                                                                |
| POST   | `/agents/:id/knowledge-bases`             | link a shared KB to an agent                                                      |
| GET    | `/agents/:id/knowledge-bases`             | KBs the agent can read                                                            |
| DELETE | `/agents/:id/knowledge-bases/:kbId`       | unlink (never the private KB)                                                     |
| POST   | `/knowledge-bases/:kbId/documents`        | upload file or text → async ingest                                                |
| POST   | `/agents/:id/documents`                   | convenience: upload into the agent's private KB                                   |
| GET    | `/knowledge-bases/:kbId/documents`        | list documents (with status)                                                      |
| DELETE | `/knowledge-bases/:kbId/documents/:docId` | delete (cascades to chunks)                                                       |
| POST   | `/agents/:id/chat`                        | `{ endUserId, message, conversationId? }`; `?stream=1` SSE; `?format=openai`      |
| POST   | `/messages/:id/feedback`                  | `{ rating: "up" \| "down" }`; `up` feeds self-learning                            |
| GET    | `/agents/:id/analytics/top-questions`     | most-asked topics                                                                 |
| GET    | `/agents/:id/analytics/learning`          | knowledge gaps, answer coverage, learned-answer pipeline                          |
| GET    | `/agents/:id/learned-answers`             | learned-answer candidates (`?status=pending\|approved\|rejected`)                 |
| POST   | `/agents/:id/learned-answers/:laId/approve` | operator approval → promote into the KB                                         |
| POST   | `/agents/:id/learned-answers/:laId/reject` | operator rejection                                                              |
| POST   | `/agents/:id/reminders`                   | schedule a reminder `{ title, dueAt, message?\|prompt?, recurrence?, endUserId? }` |
| GET    | `/agents/:id/reminders`                   | list reminders (`?status=`)                                                        |
| GET    | `/agents/:id/reminders/:rid`              | get one reminder                                                                  |
| DELETE | `/agents/:id/reminders/:rid`              | cancel a reminder                                                                 |
| GET    | `/agents/:id/reminders/:rid/deliveries`   | webhook delivery audit trail                                                      |
| POST   | `/v1/chat/completions`                    | OpenAI-compatible; `model` = agent id/name; `stream` supported                    |
| GET    | `/v1/models`                              | the org's agents, as OpenAI models                                                |
| GET    | `/health`                                 | DB ping                                                                           |
| GET    | `/ready`                                  | DB + configured Redis/Dragonfly readiness                                         |
| GET    | `/openapi.json`                           | versioned OpenAPI 3.1 contract                                                    |
| GET    | `/metrics`                                | admin-token-protected Prometheus metrics                                          |

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
  topic centroid (whose centroid then shifts toward it via a running mean), or seeds a new
  cluster. Counts + recency give "most asked" with no manual tagging.
- **Self-learning** turns endorsed answers into promoted KB knowledge and surfaces gaps;
  **reminders** fire signed webhooks at due time (see the sections above).
- The **async learning loop** (memory, topics, gap signal, reminder extraction) runs after
  the response is sent, so it never adds latency to the answer.
- **Retrieval** orders by cosine distance so the HNSW index is used, raises `ef_search`
  for the per-tenant filter, drops sub-threshold chunks, and packs under a char budget.

### Project layout

```
src/
├── index.ts            # Hono bootstrap: migrations, route mounting, workers + reminder scheduler
├── env.ts              # zod-validated environment
├── db/                 # schema, SQL migrations (vector ext), client, ownership guards
├── lib/                # embeddings, llm, chunk, parse, url-guard, guarded-fetch, webhook, crypto, queue, uuid, pagination
├── middleware/         # auth (API key → orgId), operations (request ids, metrics)
├── services/           # chat pipeline, ingest, retrieve, memory, topics, learn, learning, reminders, usage
├── routes/             # organizations, agents, knowledge-bases, documents, chat, openai, feedback, analytics, learning, reminders
└── prompts/            # system prompt + grounding rule, memory extraction, topic labels
```

---

## Stack

TypeScript · [Hono](https://hono.dev) · Postgres + [pgvector](https://github.com/pgvector/pgvector) ·
[Drizzle ORM](https://orm.drizzle.team) · LLM via Anthropic Claude **or** any
OpenAI-compatible endpoint (per agent) · embeddings via Voyage, an OpenAI-compatible
endpoint, **or** a local offline model (transformers.js) — no key required.

## Configuration

| Variable               | Required               | Description                                                             |
| ---------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`         | yes                    | Postgres connection string (pgvector-enabled)                           |
| `ANTHROPIC_API_KEY`    | for `anthropic` agents | Anthropic Claude key                                                    |
| `OPENAI_API_KEY`       | for `openai` agents    | Key for the OpenAI-compatible endpoint                                  |
| `OPENAI_BASE_URL`      | no                     | OpenAI-compatible base URL (default `https://api.openai.com/v1`)        |
| `LLM_DEFAULT_PROVIDER` | no                     | `anthropic` (default) or `openai` — used when an agent omits `provider` |
| `EMBEDDINGS_PROVIDER`  | no                     | `voyage` \| `openai` \| `local`. Unset → voyage if key set, else local  |
| `EMBEDDINGS_API_KEY`   | for voyage/openai      | embeddings key (not needed for `local`)                                 |
| `EMBEDDINGS_BASE_URL`  | no                     | `/v1` server for the `openai` embeddings provider                       |
| `EMBEDDING_DIM`        | no                     | vector dimension, locked at first migration (default 384)               |
| `SECRET_ENCRYPTION_KEY` | production            | canonical base64 32-byte AES-256-GCM key                                |
| `END_USER_SIGNING_SECRET` | production          | base64 32+ byte HMAC key for trusted end-user tokens                     |
| `LLM_ALLOWED_HOSTS`    | production             | comma-separated outbound provider hostname allowlist                    |
| `REDIS_URL`            | production             | Redis/Dragonfly URL for durable jobs, shared limits, and caches          |
| `ADMIN_TOKEN`          | production             | gates organization provisioning, management, and the metrics endpoint   |
| `RATE_LIMIT_PER_ORG`   | no                     | requests per organization per window (default 120)                      |
| `MAX_CONCURRENT_REQUESTS_PER_ORG` | no          | per-node concurrent request cap per organization (default 20)           |
| `SHUTDOWN_TIMEOUT_MS`  | no                     | maximum graceful HTTP drain time (default 15000)                        |
| `ORG_MAX_TOTAL_TOKENS` | no                     | persistent per-org token ceiling (default 10,000,000)                   |
| `ORG_MAX_ESTIMATED_COST_MICROS` | no            | persistent estimated-spend ceiling                                     |
| `ORG_MAX_DOCUMENTS`    | no                     | live per-org document ceiling                                           |
| `ORG_MAX_STORED_CHARS` | no                     | live chunk-content storage ceiling                                      |
| `RETRIEVAL_MIN_SIMILARITY` | no                 | drop chunks below this cosine similarity (default 0.2)                  |
| `CHUNK_MAX_CHARS` / `CHUNK_OVERLAP_CHARS` | no      | chunk sizing; defaults fit the local embedder (1000 / 150)             |
| `REMINDER_SCHEDULER_ENABLED` | no               | run the reminder poller on this node (default on)                       |
| `REMINDER_AUTO_EXTRACT` | no                    | extract reminders from chat via one LLM call/turn (default on)          |
| `DB_STATEMENT_TIMEOUT_MS` | no                  | server-side query timeout; 0 disables (default 30000)                   |
| `PORT`                 | no                     | HTTP port (default 3000)                                                |

See [.env.example](.env.example) for the full set (retrieval, self-learning, and
reminder tuning knobs included).

## Development

```bash
npm install
npm run dev        # tsx watch, hot reload
npm run typecheck  # tsc --noEmit
npm run migrate    # apply migrations standalone
```

## Status & roadmap

Working: tenancy + org auth, agents with auto private KB, shared KBs, ingestion
(pdf/txt/md), HNSW-indexed retrieval, per-agent LLM provider (Anthropic or any
OpenAI-compatible endpoint), native + inbound-OpenAI-compatible chat (with streaming),
per-agent memory, topic analytics, feedback, **per-org self-learning** (endorse → promote
→ gap report), and **scheduled reminders** (signed webhooks, recurrence, chat
auto-extraction).

Production controls now include signed end-user identity, encrypted tenant credentials,
explicit provider allowlists, admin-gated provisioning, per-org rate/concurrency limits,
request-time destination revalidation, persistent token/spend/storage governance,
Redis/Dragonfly-backed durable ingestion and learning, readiness, request IDs, structured
request logs, queue-aware Prometheus metrics, OpenAPI 3.1, bounded shutdown, and a non-root image.

Still deferred (see [TODO.md](TODO.md)): read-only shared-KB permissions, infrastructure
egress enforcement/connection pinning, retrieval re-ranking, conversation summarization,
distributed tracing/dashboards, and dated load, restore, and rotation drill evidence.
