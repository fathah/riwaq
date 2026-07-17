# Riwaq — AI Agent Infrastructure · Build Plan

A multi-tenant backend that hosts **unlimited independent agents**. A business creates
agents, gives each one knowledge, and end-users chat with them. Each agent answers from
its knowledge, remembers its own context, learns from its own conversations, and tracks
what gets asked most — all isolated per agent. Agents owned by the same organization can
**optionally share a knowledge base** for common information.

**Principles:** Docker-first (everything runs via `docker compose up`), API-first
(no UI; REST is the contract), boring stack (one Postgres for vectors + relational),
**isolation by default, sharing by opt-in**.

---

## 1. Tenancy & isolation model

This is the core idea, so it comes first.

```
organization (owner)
 ├── agent A ──── private KB A ─┐
 │                              ├──▶ retrieval sees: private KB + linked shared KBs
 │            ┌── shared KB X ──┘
 ├── agent B ─┤   (linked to A and B)
 │            └── private KB B
 └── agent C ──── private KB C
```

- **Organization** — the tenant boundary. Owns agents and knowledge bases. "People
  running multiple agents" = one org with many agents.
- **Agent** — independent unit. Its own memory, conversations, topics/analytics.
  Belongs to exactly one org.
- **Knowledge base (KB)** — a first-class, reusable container of documents/chunks,
  owned by an org. Two roles:
  - **Private KB** — auto-created with each agent, linked only to that agent. This is
    where `POST /agents/:id/documents` lands by default.
  - **Shared KB** — created at the org level, linked to many agents via a junction.
    For info common across an org's agents (policies, product facts, brand voice).
- **Linking** — agents ↔ KBs is **many-to-many**. An agent's retrievable knowledge =
  *its private KB + every shared KB linked to it*.

**What is isolated (never crosses agents):** memory, conversations, messages, topics,
question logs, feedback. **What can be shared (opt-in, within an org):** knowledge bases.

> Shared *memory* across agents is intentionally **out of scope for v1** — memory stays
> per-agent (optionally per-end-user). See section 11.

---

## 2. Architecture

### Request pipeline (one chat turn)

```
Input ──▶ KB search (own + shared) + Memory recall ──▶ Build prompt ──▶ LLM ──▶ Output
                                                                              │
                                                      persist + learn (async) ┘
```

Synchronous path returns the answer fast. The **learning loop** (persist messages,
extract memory, classify topic, update counters) runs *after* the response is sent.

### Components

| # | Component | Responsibility |
|---|-----------|----------------|
| 1 | **Input** | REST: `{ agentId, conversationId?, endUserId, message }` |
| 2 | **Knowledge Base (RAG)** | Ingest into a KB (parse → chunk → embed → store); search across the agent's full KB set (private + shared) by cosine, top-k |
| 3 | **Memory** | Short-term = last N turns; long-term = durable facts (text + embedding). **Per-agent, isolated.** |
| 4 | **LLM** | Prompt = system + long-term memory + retrieved chunks + recent history + user message → Claude |
| 5 | **Output** | `{ answer, citations[], conversationId }` (citations name the source KB + document) |
| 6 | **Learning loop** | Persist messages + used chunks; extract memory; classify topic + counters; feedback / KB-gap flags |
| 7 | **Channels** | Normalize Telegram and future providers into the same agent chat, memory, analytics, and learning pipeline |

---

## 3. Stack decisions

- **Runtime:** TypeScript + Node 20+.
- **Framework: Hono.** Chosen over Nitro — lean, API-first router with first-class SSE
  streaming (chat), tiny footprint, no SSR/full-stack baggage. Nitro is for full-stack/SSR;
  this is a pure backend.
- **DB:** Postgres 16 + `pgvector` (vectors + relational in one place). Image:
  `pgvector/pgvector:pg16`.
- **DB access:** `postgres` (postgres.js) + `drizzle-orm` for typed schema & migrations
  (clean pgvector support).
- **LLM (provider-agnostic, layered config):** config resolves
  **agent override → org config → `.env` default** (`services/llm-config.ts`).
  - `anthropic` — Claude via `@anthropic-ai/sdk` (default `claude-haiku-4-5-20251001`,
    `claude-sonnet-4-6` when quality matters).
  - `openai` — **any OpenAI-compatible endpoint** via the `openai` SDK pointed at a
    `baseURL` (OpenAI, OpenRouter, Groq, Together, Ollama, vLLM, LM Studio…).
  - An **org brings its own** `provider`/`baseURL`/`apiKey`/`model`; the org bundle only
    applies when the resolved provider matches it (an agent that switches provider falls
    back to env creds, not the org's). Deployment defaults: `LLM_DEFAULT_PROVIDER`,
    `LLM_DEFAULT_MODEL`, `OPENAI_BASE_URL`, keys.
  - Both backends sit behind one `complete()` / `streamText()` interface in `lib/llm.ts`
    (unified streaming), so the chat pipeline, memory extraction, and topic labeling are
    provider-blind. Clients are cached per (baseURL, apiKey).
- **Embeddings (pluggable, offline fallback):** `voyage` (REST), `openai` (any
  `/v1/embeddings` server — OpenAI, Ollama, LM Studio), or `local` (in-process
  transformers.js, offline, no key — default `all-MiniLM-L6-v2`, 384-d). Unset provider
  → voyage if a key is set, else local. `EMBEDDING_DIM` is templated into the vector
  columns at migration time (default 384) and every provider must emit that dim
  (OpenAI via its `dimensions` param; Voyage = 1024). Never mix dims in one DB.
- **File parsing (start small):** PDF (`pdf-parse`), TXT, MD. Later: DOCX (`mammoth`), CSV.
- **Validation:** `zod` on every endpoint body.
- **Background jobs:** BullMQ + Redis/Dragonfly in production, with idempotency keys,
  retries, exponential backoff, and retained failed jobs. Development can use the
  explicitly non-durable in-process fallback.

---

## 4. Project layout

```
riwaq/
├── docker-compose.yml          # api + postgres(pgvector)
├── Dockerfile                  # multi-stage node build
├── .env.example
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── plan.md
└── src/
    ├── index.ts                # Hono bootstrap + route mounting
    ├── env.ts                  # zod-validated env
    ├── db/
    │   ├── client.ts
    │   ├── schema.ts           # all tables (section 6)
    │   └── migrations/         # incl. CREATE EXTENSION vector
    ├── lib/
    │   ├── embeddings.ts       # EmbeddingProvider (Voyage)
    │   ├── llm.ts              # Anthropic client + helpers
    │   ├── chunk.ts            # text → chunks (~500-1000 tok, ~100 overlap)
    │   └── parse.ts            # file → text (pdf/txt/md)
    ├── routes/
    │   ├── organizations.ts    # + /organizations/learning (threshold), /organizations/webhook
    │   ├── agents.ts
    │   ├── knowledge-bases.ts  # create/list KBs; attach/detach to agents
    │   ├── documents.ts        # upload into a KB
    │   ├── chat.ts             # native POST /agents/:id/chat
    │   ├── openai.ts           # OpenAI-compatible /v1/chat/completions + /v1/models
    │   ├── feedback.ts         # up-vote feeds self-learning
    │   ├── analytics.ts        # top-questions + learning report
    │   ├── learning.ts         # learned-answer candidates: list / approve / reject
    │   ├── reminders.ts        # schedule / list / cancel / deliveries
    │   └── channels.ts         # messaging connection management + polling intake
    ├── serializers.ts          # canonical ChatResult → native | openai (+ stream frames)
    ├── services/
    │   ├── chat.ts             # prepare / run / stream (canonical, prepared-turn split)
    │   ├── llm-config.ts       # resolve agent → org → .env LLM config
    │   ├── ingest.ts           # parse → chunk → embed → store (into a KB)
    │   ├── retrieve.ts         # resolve agent's KB set → HNSW top-k across them
    │   ├── memory.ts           # recall + extraction/upsert (per-agent)
    │   ├── topics.ts           # classify → nearest centroid (running mean) / new cluster
    │   ├── learn.ts            # async loop: memory + topics + gap signal + reminder extract
    │   ├── learning.ts         # self-learning: endorse → cluster → promote → report
    │   ├── reminders.ts        # CRUD + scheduler tick (claim/fire/deliver) + auto-extract
    │   ├── channels.ts         # channel sessions/events + canonical chat dispatch
    │   └── usage.ts            # persistent token/spend/storage governance
    └── prompts/
        ├── system.ts
        └── memory-extract.ts
```

---

## 5. API surface

**Organizations & agents**
| Method | Path | Body / Notes |
|--------|------|--------------|
| POST | `/organizations` | `{ name }` → org (returns apiKey once) |
| GET | `/organizations/me` | org + LLM config (key masked) |
| PUT | `/organizations/llm` | `{ provider?, baseUrl?, apiKey?, model? }` (null clears → .env) |
| POST | `/agents` | `{ name, systemPrompt?, provider?, model? }` → auto-creates a private KB |
| GET | `/agents/:id` | agent + linked KBs + `effectiveLlm` |

**Knowledge bases (first-class, shareable)**
| Method | Path | Body / Notes |
|--------|------|--------------|
| POST | `/organizations/:orgId/knowledge-bases` | `{ name }` → shared KB |
| GET | `/organizations/:orgId/knowledge-bases` | list org KBs |
| POST | `/agents/:id/knowledge-bases` | `{ knowledgeBaseId }` → link shared KB to agent |
| GET | `/agents/:id/knowledge-bases` | KBs this agent can read (private + shared) |
| DELETE | `/agents/:id/knowledge-bases/:kbId` | unlink (never unlinks/deletes the private KB this way) |

**Documents (live in a KB)**
| Method | Path | Body / Notes |
|--------|------|--------------|
| POST | `/knowledge-bases/:kbId/documents` | multipart file **or** `{ text, name }` → async ingest |
| POST | `/agents/:id/documents` | convenience: uploads into the agent's **private** KB |
| GET | `/knowledge-bases/:kbId/documents` | list |
| DELETE | `/knowledge-bases/:kbId/documents/:docId` | cascades to chunks |

**Chat, feedback, analytics**
| Method | Path | Body / Notes | Returns |
|--------|------|--------------|---------|
| POST | `/agents/:id/chat` | `{ conversationId?, endUserId, message }`, `?stream=1` | `{ answer, citations[], conversationId }` |
| POST | `/messages/:id/feedback` | `{ rating: "up" \| "down" }` | `{ ok }` |
| GET | `/agents/:id/analytics/top-questions` | per-agent | `[{ label, count, lastSeen }]` |
| GET | `/health` | DB ping | `{ ok }` |

**Messaging channels**
| Method | Path | Body / Notes |
|--------|------|--------------|
| GET | `/channels` | List organization connections; credentials are never returned |
| GET | `/agents/:id/channels` | List one agent's connections |
| POST | `/agents/:id/channels/telegram` | `{ token }` → verify bot + start outbound polling |
| DELETE | `/agents/:id/channels/:channelId` | Stop polling and remove local credentials |

**OpenAI-compatible (inbound)**
| Method | Path | Body / Notes | Returns |
|--------|------|--------------|---------|
| POST | `/v1/chat/completions` | OpenAI chat shape; `model` = agent id or name; `stream` supported | `chat.completion` (+ `riwaq` extension) |
| GET | `/v1/models` | lists the org's agents as models | `{ object:'list', data:[...] }` |

---

## 5b. Output contract & formats

One **canonical result** is the single source of truth; every wire format is a pure
projection of it (`serializers.ts`). The provider is normalized away *before*
serialization, so output structure depends only on *(canonical result × format)* —
never on the backend.

```
provider (anthropic | openai | future) ─▶ complete()/streamText() ─▶ canonical ChatResult
                                                                            │
                                                            serializer ─────┤
                                                                       native | openai | …
```

- **Canonical `ChatResult`** (`services/chat.ts`): `{ conversationId, answer, citations[],
  model, usage, finishReason }` — no provider-specific fields. `finishReason` is normalized
  (`stop | length | tool_use | content_filter | other`). Streaming uses canonical
  `ChatStreamEvent`s (`meta → token* → done`).
- **Native** is the first-party contract (our shape, in and out); **OpenAI** is a serializer
  view, available as the dedicated `/v1/chat/completions` *or* `?format=openai` on the
  native endpoint.
- **Rule:** providers map *into* the canonical result; serializers map *out* of it. A new
  provider = a new adapter (no output change); a new format = a new serializer branch (no
  pipeline change). Existing clients can't break.

---

## 5a. OpenAI-compatible API

Lets any OpenAI client/tool (the `openai` SDKs, LangChain, OpenWebUI, LibreChat…)
drive a Riwaq agent with **zero custom code** — it's an adapter over the same
`prepareChatTurn` pipeline the native `/agents/:id/chat` uses, so RAG + memory +
topic learning all run identically.

- **Base URL:** `<host>/v1`. **Auth:** org API key sent as the OpenAI `api_key`
  (`Authorization: Bearer …`) — resolved by the same `orgAuth` middleware.
- **Agent selection:** the OpenAI `model` field = the agent **id (uuid)** or its
  **name** within the org. The underlying Claude model is the agent's own `model`.
- **History is client-owned:** the request's `messages` array is the turn history
  (OpenAI contract). The last `user` message is the RAG query; earlier user/assistant
  messages become history. Each call still persists to a conversation + runs the
  async learning loop, so memory/topics accumulate per agent + `user`.
- **Client `system` messages are ignored** — the agent's own system prompt and the
  grounding rule stay authoritative (prevents callers from overriding safety).
- **Streaming:** `stream:true` emits standard `chat.completion.chunk` frames ending
  in `[DONE]`; `stream_options.include_usage` adds a usage frame.
- **Extension field:** responses carry a non-standard `riwaq: { conversationId,
  citations[] }` alongside the standard payload (OpenAI clients ignore unknown keys),
  so retrieval sources remain available without breaking compatibility.

```
POST /v1/chat/completions
{ "model": "<agentId|agentName>",
  "messages": [{"role":"user","content":"…"}],
  "user": "u_123", "stream": false }
```

---

## 6. Data model (Postgres + pgvector)

```
organizations         id, name, api_key_hash, api_key_prefix,
                      llm_provider, llm_base_url, llm_api_key, llm_api_key_encrypted,
                      llm_model,   -- per-org LLM (nullable → .env)
                      created_at

agents                id, org_id→, name, system_prompt,
                      provider, model,   -- nullable per-agent overrides (null → inherit org/.env)
                      created_at

knowledge_bases       id, org_id→, agent_id→(private owner), name, is_default(bool), created_at
                      -- is_default = the private KB auto-made for one agent

agent_knowledge_bases agent_id→, knowledge_base_id→        -- M:N link (PK = both)

documents             id, knowledge_base_id→, name, source,
                      status(processing|ready|error), created_at

chunks                id, document_id→, knowledge_base_id→, content,
                      embedding vector(EMBEDDING_DIM), metadata jsonb
                      -- scoped to KB, NOT to agent

conversations         id, agent_id→, end_user_id, summary, created_at
messages              id, conversation_id→, role(user|assistant), content,
                      used_chunk_ids uuid[], feedback(null|up|down), tokens, created_at
memories              id, agent_id→, end_user_id(nullable), fact,
                      embedding vector(EMBEDDING_DIM), updated_at
topics                id, agent_id→, label, centroid vector(EMBEDDING_DIM), count, last_seen
question_logs         id, agent_id→, message_id→(unique), topic_id→,
                      embedding vector(EMBEDDING_DIM), created_at
```

**Key relationships**
- `chunks` belong to a **KB**; an agent reaches them only via `agent_knowledge_bases`.
- Agent creation flow: insert agent → insert `knowledge_bases (is_default=true)` →
  insert `agent_knowledge_bases` link. So every agent always has ≥1 KB.
- Memory/conversations/topics carry `agent_id` directly → hard per-agent isolation.

**Indexes:** HNSW cosine on `chunks.embedding`, `memories.embedding`, `topics.centroid`.
Btree on all FKs and on `agent_knowledge_bases(agent_id)`. Migration must
`CREATE EXTENSION IF NOT EXISTS vector;` first.

---

## 7. Chat flow (detailed)

1. Resolve or create the conversation (`conversationId` optional).
2. Embed the user message (Voyage).
3. **Resolve KB set:** `SELECT knowledge_base_id FROM agent_knowledge_bases WHERE agent_id = $1`.
4. **KB search:** top-k chunks `WHERE knowledge_base_id = ANY(kbSet)` by cosine similarity.
5. **Memory recall:** last N messages (this conversation) + top long-term memories
   (`WHERE agent_id = $1`, vector search).
6. **Compose prompt:** system + long-term memory + chunks + history + message.
   Rule baked in: *"Answer only from the provided context; if unknown, say so."*
7. Call Claude → answer (stream if `?stream=1`).
8. Persist user + assistant messages (+ `used_chunk_ids`). Return response with
   citations (each citation resolves chunk → document → KB name, so the user sees
   whether an answer came from private or shared knowledge).
9. **Durable learning:** enqueue memory extraction + topic classification. Jobs retry
   with idempotency by user-message ID; topic creation is serialized per agent.

---

## 8. "Keeps learning" — concretely

- **Memory (per-agent):** after each turn, one cheap Haiku call extracts durable facts
  → upsert into `memories` (scoped to `agent_id`) → injected into that agent's future prompts.
- **Question trends (per-agent):** every user message is embedded and assigned to a
  topic cluster; new clusters auto-form. Counts + recency power **top-questions** with
  zero manual tagging.
- **Feedback → self-learning (implemented):** thumbs-down answers + questions that
  retrieved weak chunks surface KB gaps (the **learning report**); thumbs-up answers are
  clustered and, once enough distinct users endorse one (or an operator approves), the
  Q&A is **promoted back into the agent's KB**. See section 13.

---

## 9. Docker setup

- **`docker-compose.yml`:** development stack with Postgres, Dragonfly, and API.
- **`docker-compose.prod.yml`:** internal DB/cache networking, required production
  secrets and allowlist, admin-gated provisioning, and no source mounts.
- **`Dockerfile`:** production-only dependencies, narrow source copy, non-root user,
  slim runtime (`node:20-slim`).
- **First run:** `docker compose up` → API waits for DB → migrations → ready.
- **Env (`.env.example`):**
  ```
  DATABASE_URL=postgres://riwaq:riwaq@db:5432/riwaq
  ANTHROPIC_API_KEY=
  EMBEDDINGS_API_KEY=          # Voyage AI key
  PORT=3000
  ```

---

## 10. Build order (milestones)

- [x] **M0 — Scaffold.** Hono app, Docker (api + pgvector), `/health`, env loader.
- [x] **M1 — Tenancy + CRUD.** Schema, migrations (incl. `vector` ext), orgs, agents
      (with auto private-KB), knowledge_bases, agent↔KB linking.
- [x] **M2 — Ingestion.** Upload into a KB → parse → chunk → embed → store; status
      lifecycle; list/delete; agent convenience route → private KB.
- [x] **M3 — Retrieval.** Resolve agent KB set → top-k across private + shared, tested
      in isolation (seed two KBs, assert an agent only sees its linked set).
- [x] **M4 — Chat.** Retrieve + history → Claude → answer + citations (with KB/source);
      persist messages; optional SSE stream.
- [x] **M5 — Long-term memory.** Per-agent extraction + upsert; recall + injection.
- [x] **M6 — Analytics.** Per-agent topic clustering + `top-questions`.
- [x] **M7 — Feedback.** `feedback` endpoint + KB-gap flagging.

Ship M0–M4 as the usable core; M5–M7 are the "learning" layer.

---

## 11. Open questions / deferred

- Organization API keys and signed end-user identity are implemented. Future identity
  work may add OIDC/JWKS as an alternative to the current shared HMAC trust boundary.
- **Shared memory across agents** — out of scope; memory is per-agent by design.
- KB-level access control (read-only vs writable shared KBs).
- Queue dashboards, load/failure drills, and separate worker deployment at larger scale.
- Connection-pinned SSRF enforcement and infrastructure egress policy. Production
  requires an explicit hostname allowlist, blocks private DNS answers, and the outbound
  fetch refuses redirects; socket-level IP pinning is the remaining hardening.
- Tracing, SLO dashboards, and alerting.
- Re-ranking retrieved chunks (cross-encoder) and hybrid (BM25 + vector) retrieval.
- Conversation summarization to bound short-term history token cost.
- Durable (queue-backed) capture of up-vote endorsements and reminder auto-extraction;
  both currently run best-effort in-process alongside the async learn loop.

_Done since first draft:_ persistent token/spend/storage governance; retrieval now uses
the HNSW index with a relevance floor and char budget; topic centroids move (running
mean); promotion of endorsed Q&A back into a KB (self-learning); scheduled reminders.

---

## 12. A+ production execution plan

The live checklist is [TODO.md](TODO.md). Work proceeds in this order:

1. **Trust and governance:** revalidate outbound destinations at use time and persist
   tenant request/token/storage/spend usage with hard limits.
2. **Contract:** publish OpenAPI 3.1 and test the documented native/OpenAI surfaces.
3. **Reliability:** expose queue dependency health, test retries/recovery/migrations, and
   make the production release gate reproducible.
4. **Operations:** define SLOs, alerts, backup/restore, rotation, load, restart, and
   forced-shutdown drills.
5. **External deployment proof:** enforce network egress outside the process and attach
   dated drill evidence. This final item cannot be truthfully satisfied by source code
   alone.

---

## 13. Self-learning (per org)

A feedback flywheel over signals the pipeline already emits — no model training.

- **Signals.** Each turn records `messages.feedback` (up/down), `messages.used_chunk_ids`,
  the topic cluster, and `question_logs.top_similarity` (best retrieval score → gap signal).
- **Endorse → cluster.** A thumbs-up feeds `captureUpvote`: the question is embedded and
  matched (≥ `LEARNED_DEDUP_SIMILARITY`) to an existing **learned-answer** candidate under a
  per-agent advisory lock, else a new candidate is created. `learned_answer_votes` has a
  composite PK `(candidate, end_user)` so a single user can't inflate `distinct_user_count`.
- **Promote.** Operator approval (default) or auto-promotion once `distinct_user_count`
  reaches the org's `learned_auto_promote_threshold`. Promotion writes the Q&A into the
  agent's private KB as a `source='learned'` document → chunked → embedded → retrievable.
- **Report.** `GET /agents/:id/analytics/learning` — knowledge gaps ranked by frequency
  (`top_similarity < LEARNING_GAP_SIMILARITY`), answer coverage, candidate pipeline counts.
- **Safety.** End-user feedback is untrusted; a candidate only becomes knowledge via the
  distinct-user threshold or an operator. Everything is org/agent-scoped.

Tables: `learned_answers`, `learned_answer_votes`; `organizations.learned_auto_promote_threshold`;
`question_logs.top_similarity` (migration `0011`).

## 14. Reminders

Agents remember dates (renewals, deadlines) and fire a **signed webhook** at due time.

- **Model.** `reminders` (agent/org/end-user, `message` or `prompt`, `due_at`, `recurrence`,
  `status`, `source`, `next_fire_at`, attempt/fire counts) + `reminder_deliveries` audit;
  `organizations.webhook_url` + encrypted `webhook_secret` (migration `0012`).
- **Scheduler.** A DB poller claims due rows with `FOR UPDATE SKIP LOCKED` (multi-node
  safe, no Redis needed), started at boot and stopped on shutdown.
- **Fire.** Compose the body (static `message`, or the agent's LLM from `prompt`), POST it
  HMAC-signed (`X-Riwaq-Signature` over `timestamp.body`) through the SSRF-guarded fetch
  (private IPs blocked, redirects refused, timeout), and log the delivery. Recurring
  reminders advance; one-offs complete; failures back off then flip to `error`.
- **Creation.** Explicit API (`POST /agents/:id/reminders`) or, when `REMINDER_AUTO_EXTRACT`
  is on, auto-extracted from chat by the learn loop with guardrails (future-only, horizon
  cap, per-user cap, dedupe).
