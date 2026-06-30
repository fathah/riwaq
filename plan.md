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
- **Embeddings:** Voyage AI `voyage-3` (Anthropic's recommended partner), **1024 dims**,
  via REST. `vector(1024)` columns are locked to this. An `EmbeddingProvider` interface
  keeps OpenAI `text-embedding-3-small` (1536) swappable — never mix dims in one DB.
- **File parsing (start small):** PDF (`pdf-parse`), TXT, MD. Later: DOCX (`mammoth`), CSV.
- **Validation:** `zod` on every endpoint body.
- **Background jobs (v1):** in-process fire-and-forget. Upgrade path: BullMQ + Redis.

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
    │   ├── organizations.ts
    │   ├── agents.ts
    │   ├── knowledge-bases.ts  # create/list KBs; attach/detach to agents
    │   ├── documents.ts        # upload into a KB
    │   ├── chat.ts             # native POST /agents/:id/chat
    │   ├── openai.ts           # OpenAI-compatible /v1/chat/completions + /v1/models
    │   ├── feedback.ts
    │   └── analytics.ts
    ├── services/
    │   ├── chat.ts             # prepareChatTurn — shared pipeline (native + OpenAI)
    │   ├── llm-config.ts       # resolve agent → org → .env LLM config
    │   ├── ingest.ts           # parse → chunk → embed → store (into a KB)
    │   ├── retrieve.ts         # resolve agent's KB set → top-k across them
    │   ├── memory.ts           # recall + extraction/upsert (per-agent)
    │   ├── topics.ts           # classify → nearest centroid / new cluster
    │   └── learn.ts            # async loop orchestration
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

**OpenAI-compatible (inbound)**
| Method | Path | Body / Notes | Returns |
|--------|------|--------------|---------|
| POST | `/v1/chat/completions` | OpenAI chat shape; `model` = agent id or name; `stream` supported | `chat.completion` (+ `riwaq` extension) |
| GET | `/v1/models` | lists the org's agents as models | `{ object:'list', data:[...] }` |

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
organizations         id, name, api_key,
                      llm_provider, llm_base_url, llm_api_key, llm_model,   -- per-org LLM (nullable → .env)
                      created_at

agents                id, org_id→, name, system_prompt,
                      provider, model,   -- nullable per-agent overrides (null → inherit org/.env)
                      created_at

knowledge_bases       id, org_id→, name, is_default(bool), created_at
                      -- is_default = the private KB auto-made for one agent

agent_knowledge_bases agent_id→, knowledge_base_id→        -- M:N link (PK = both)

documents             id, knowledge_base_id→, name, source,
                      status(processing|ready|error), created_at

chunks                id, document_id→, knowledge_base_id→, content,
                      embedding vector(1024), metadata jsonb
                      -- scoped to KB, NOT to agent

conversations         id, agent_id→, end_user_id, summary, created_at
messages              id, conversation_id→, role(user|assistant), content,
                      used_chunk_ids uuid[], feedback(null|up|down), tokens, created_at
memories              id, agent_id→, end_user_id(nullable), fact,
                      embedding vector(1024), updated_at
topics                id, agent_id→, label, centroid vector(1024), count, last_seen
question_logs         id, agent_id→, message_id→, topic_id→, embedding vector(1024), created_at
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
9. **Async learning:** extract memory (per-agent) → upsert; classify topic (nearest
   centroid above threshold, else new); increment `topics.count`; write `question_logs`.

---

## 8. "Keeps learning" — concretely

- **Memory (per-agent):** after each turn, one cheap Haiku call extracts durable facts
  → upsert into `memories` (scoped to `agent_id`) → injected into that agent's future prompts.
- **Question trends (per-agent):** every user message is embedded and assigned to a
  topic cluster; new clusters auto-form. Counts + recency power **top-questions** with
  zero manual tagging.
- **Feedback:** thumbs-down answers + questions that retrieved weak chunks surface KB
  gaps; optionally promote highly-rated Q&A pairs back into a KB later.

---

## 9. Docker setup

- **`docker-compose.yml`:** `db` (pgvector/pgvector:pg16, healthcheck, volume) + `api`
  (depends_on db healthy; dev hot-reload via `tsx watch`).
- **`Dockerfile`:** multi-stage — deps → build → slim runtime (`node:20-slim`).
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

- [ ] **M0 — Scaffold.** Hono app, Docker (api + pgvector), `/health`, env loader.
- [ ] **M1 — Tenancy + CRUD.** Schema, migrations (incl. `vector` ext), orgs, agents
      (with auto private-KB), knowledge_bases, agent↔KB linking.
- [ ] **M2 — Ingestion.** Upload into a KB → parse → chunk → embed → store; status
      lifecycle; list/delete; agent convenience route → private KB.
- [ ] **M3 — Retrieval.** Resolve agent KB set → top-k across private + shared, tested
      in isolation (seed two KBs, assert an agent only sees its linked set).
- [ ] **M4 — Chat.** Retrieve + history → Claude → answer + citations (with KB/source);
      persist messages; optional SSE stream.
- [ ] **M5 — Long-term memory.** Per-agent extraction + upsert; recall + injection.
- [ ] **M6 — Analytics.** Per-agent topic clustering + `top-questions`.
- [ ] **M7 — Feedback.** `feedback` endpoint + KB-gap flagging.

Ship M0–M4 as the usable core; M5–M7 are the "learning" layer.

---

## 11. Open questions / deferred

- **Auth & API keys per org** — not in v1; required before real deployment (every
  request must be scoped to an org so tenants can't read each other's KBs/agents).
- **Shared memory across agents** — out of scope; memory is per-agent by design.
- KB-level access control (read-only vs writable shared KBs).
- Rate limiting / quota per org or agent.
- Durable job queue (BullMQ + Redis) once ingestion volume grows.
- Re-ranking retrieved chunks (cross-encoder) for quality.
- Conversation summarization to bound short-term history token cost.
