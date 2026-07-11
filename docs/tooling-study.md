# Riwaq — Memory & Knowledge-Base Tooling Study

**Date:** 2026-07-01 · **Author:** engineering
**Status:** research / recommendation (no code changes)

> Sourced from working knowledge (cutoff Jan 2026); the live web could not be
> reached at authoring time, so pin exact versions/benchmarks before adopting.

## 0. Why this study

Riwaq currently hand-rolls both of its "intelligence" subsystems:

- **Memory:** extract facts with a Haiku call → embed → cosine top-5 recall →
  dedup at 0.92 similarity, scoped per `(agent, end_user)`. Topics via centroid
  clustering.
- **Knowledge base (RAG):** `pdf/txt/md` → fixed-size character chunking → embed →
  pgvector cosine top-k. No hybrid search, no reranking, threshold off by default.

Both work, but they're the *floor* of what's possible. The question: which
industry-standard tools would raise quality/efficiency **without** violating
Riwaq's principles — *boring stack (one Postgres), self-hosted, isolation by
default, provider-agnostic, API-first*. That constraint matters: it rules out most
managed SaaS and heavyweight frameworks and favors Postgres-native + self-hostable
OSS that we can run per-tenant.

---

## 1. Agent memory

### The landscape

| Tool | What it is | Storage model | Self-host | License | Fit for Riwaq |
|---|---|---|---|---|---|
| **Mem0** | Memory layer: LLM extracts + consolidates facts, handles add/update/delete (contradiction resolution) | Pluggable vector store (incl. **pgvector**), optional graph | Yes (OSS) + managed | Apache-2.0 | **High** — closest to what we already do, same storage |
| **Zep** | Temporal knowledge-graph memory; tracks facts over time with validity intervals; auto fact extraction | Its own service (graph + vector) | Yes (Community) + cloud | Apache-2.0 core | Medium — powerful "graphiti" temporal model, but a separate service |
| **Letta (MemGPT)** | Stateful *agent runtime* with self-editing memory tiers (core/archival) + paging | Postgres/pgvector | Yes | Apache-2.0 | Low/Medium — it's an agent framework, not a memory library; owns the loop |
| **Cognee** | ECL (extract-cognify-load) memory → knowledge graph | Graph + vector | Yes | Apache-2.0 | Medium — graph-first; heavier |
| **LangMem** | LangChain's memory utilities (extraction, summarization) | Bring-your-own | Yes | MIT | Low — couples to LangChain idioms |

### Gap analysis vs Riwaq's current memory

What the good tools do that we don't:

1. **Contradiction / update handling.** We only *dedup* near-identical facts. Mem0/Zep
   detect that a new fact *supersedes or conflicts with* an old one ("moved to Berlin"
   invalidates "lives in Paris") and update/expire it. Ours would keep both.
2. **Temporal validity (Zep).** Facts carry "valid from/to" so recall reflects the
   *current* truth and can answer "what was true in March." We have only `updated_at`.
3. **Memory types.** Episodic (events) vs semantic (durable facts) vs procedural
   (how-to) are handled distinctly; we have one flat `fact` table.
4. **Graph relations.** Zep/Cognee link entities ("Acme → employs → Alice"), enabling
   multi-hop recall. We do pure vector similarity.
5. **Consolidation/summarization** of long histories to bound token cost (an open item
   in our own plan.md §11).

### Recommendation for memory

**Do not adopt a memory *service* wholesale.** Zep/Letta each want to own a service or
the agent loop, which fights our isolation-by-default, per-tenant, "one Postgres" model
and our canonical chat pipeline.

Two viable paths, in order of preference:

- **(A) Borrow the techniques, keep our store (recommended first).** Add to our existing
  `memories` table + extraction step: (1) an **update/invalidate** path (when a new fact
  conflicts with a nearby one, mark the old superseded instead of storing both);
  (2) a `type` column (episodic/semantic); (3) optional `valid_from/valid_to` for
  temporal facts. This is a few migrations + prompt changes, stays in Postgres, and
  preserves strict per-user isolation. ~80% of the value, ~20% of the disruption.
- **(B) Adopt Mem0 (OSS) as the memory engine, backed by our pgvector.** Mem0 is the
  only major option that plugs into *our* Postgres and is a *library*, not a runtime.
  It brings consolidation/contradiction handling for free. Cost: it's Python (we're
  TypeScript) → it'd run as a sidecar service, adding a language + deployment surface,
  and we'd have to enforce our tenant isolation around its API. Consider only if (A)'s
  quality proves insufficient.

**Avoid** making Letta/Zep the system of record — too much architectural gravity.

---

## 2. Knowledge base (RAG) — by pipeline stage

RAG quality is a pipeline; the biggest wins are in the stages we currently do most
naively (parsing, retrieval quality). Best-in-class per stage:

### 2.1 Ingestion / parsing ("gaining" the KB)

We do `pdf-parse` + raw text. This loses tables, layout, and structure — the usual
cause of "the answer was in the doc but retrieval missed it."

| Tool | Strengths | License / mode | Notes |
|---|---|---|---|
| **Docling** (IBM) | Layout-aware PDF, **tables**, OCR, code/formulas → clean Markdown/JSON; ships a chunker | MIT, **local** | Best OSS fit: local, permissive, no per-page fee |
| **Unstructured** | Very broad format coverage (email, pptx, html…), partition + clean | OSS (Apache) + paid API | Great breadth; OSS extras can be heavy |
| **LlamaParse** | Excellent complex-PDF/table quality | **Managed API**, paid | Quality leader but SaaS + per-page cost → conflicts with self-host |
| **Firecrawl** | Web → clean Markdown (crawl/scrape) | OSS + API | Add when web ingestion becomes a source |
| **Apache Tika** | Battle-tested extraction for 1000s of types | Apache, self-host | Java sidecar; good fallback breadth |

**Pick: Docling** as the primary parser (local, MIT, tables/layout), Tika/Unstructured
as breadth fallback, Firecrawl later for web sources.

### 2.2 Chunking

Fixed-character chunking splits mid-table and mid-idea. Upgrades:
- **Structural/semantic chunking** — split on document structure (headings, tables) and
  semantic boundaries. Docling emits structure we can chunk on; libraries like
  **Chonkie** (fast, MIT) or LlamaIndex node parsers do semantic/late chunking.
- **Late chunking / contextual retrieval** — embed with surrounding context so a chunk
  isn't stranded from its section. High recall gain, low cost.

### 2.3 Storage & indexing

We use `pgvector` HNSW cosine. Keep Postgres, but the ecosystem now covers scale + hybrid:

| Option | Adds | Fit |
|---|---|---|
| **pgvector** (current) | HNSW/IVF ANN in Postgres | Keep — the boring-stack anchor |
| **pgvectorscale** (Timescale) | StreamingDiskANN + quantization → bigger-than-RAM, faster, cheaper | **High** — drop-in Postgres extension when corpora grow |
| **ParadeDB `pg_search`** | **BM25** full-text in Postgres (Tantivy) | **High** — enables true hybrid *inside one DB* |
| Qdrant / Weaviate / Milvus | Dedicated vector DBs w/ built-in hybrid, filtering, quantization | Medium — more power, but a *second* datastore vs our one-Postgres rule |
| Pinecone / managed | Zero-ops vector search | Low — SaaS, per-tenant isolation + egress concerns |
| LanceDB | Embedded columnar vector store | Niche — great for local/edge, not multi-tenant server |

**Pick: stay on Postgres.** Add **pgvectorscale** when scale demands, and **ParadeDB
pg_search** to get BM25 without a second system. Only move to Qdrant/Weaviate if
multi-tenant vector features (named vectors, advanced filtering at scale) become the
bottleneck — and weigh it against the "one datastore" principle.

### 2.4 Retrieval quality — **the highest-ROI area**

This is where Riwaq is weakest and where the prior review's finding #11 lives. Three
compounding upgrades, roughly in ROI order:

1. **Reranking (do this first).** Retrieve top-N (~50) by vector, then a cross-encoder
   reranker reorders to the best top-k. Biggest single quality jump for least effort.
   - **Cohere Rerank** / **Voyage rerank** — API, excellent, fits our already
     provider-agnostic embeddings config (add a `reranker` provider the same way).
   - **bge-reranker-v2** / **Jina reranker** — OSS, run **local** via transformers.js
     (mirrors our offline-embeddings fallback) → no key, no egress.
2. **Hybrid search (vector + BM25).** Dense misses exact terms/IDs/rare tokens; BM25
   catches them. Combine with **Reciprocal Rank Fusion**. With ParadeDB this stays in
   Postgres. Directly addresses "answer was in the doc but not retrieved."
3. **Query transformation.** Rewrite/expand the user query (and/or HyDE, multi-query)
   before retrieval — cheap Haiku call, better recall on vague questions.

### 2.5 Orchestration frameworks (use with caution)

- **LlamaIndex** — the most RAG-focused framework (parsers, node stores, query engines,
  rerankers). **Haystack** — production pipelines. **LangChain** — broad but heavy.
- **Caution:** adopting a framework wholesale conflicts with our "small, readable,
  no framework machinery" strength (a thing the reviews praised). Prefer to **borrow
  specific components** (a node parser, a reranker wrapper) over restructuring the app
  around a framework. For TypeScript, LlamaIndex.TS / a thin custom layer fits better.

### 2.6 Evaluation (the missing discipline)

We tune retrieval blind. Standard tools give numbers:
- **Ragas** — faithfulness, answer/context relevance, context precision/recall.
- **DeepEval** — pytest-style LLM eval + RAG metrics + regression gating in CI.
- **TruLens** — tracing + feedback functions.

**Pick: Ragas** to build a small retrieval/answer eval set; wire it into CI so
threshold/rerank/chunking changes are measured, not guessed. This is also the concrete
answer to the reviews' "no retrieval evaluation" gap.

### 2.7 Managed RAG-as-a-service (for contrast)

**Amazon Bedrock Knowledge Bases, Azure AI Search, Vectara, Ragie, Google Vertex RAG**
bundle parse→chunk→embed→store→retrieve→rerank behind one API. Fast to adopt, but each
is a **managed, external** system: it conflicts with self-hosting, complicates
per-tenant isolation, and sends customer documents off-box. Good to know as the "buy"
option; **not** aligned with Riwaq's stated model.

---

## 3. Recommendation — what to adopt, and when

Ordered by ROI-to-effort, every item consistent with our principles (Postgres-first,
self-hostable, provider-agnostic, isolation-preserving):

### Now (biggest quality wins, low disruption)
1. **Reranking** — add a `reranker` to the retrieval step (OSS bge-reranker local by
   default; Cohere/Voyage as pluggable API), mirroring the embeddings-provider design.
2. **Ragas eval harness in CI** — a seed Q/A set + metrics, so every retrieval change is
   measured. (Closes the reviews' retrieval-evaluation gap.)
3. **Better parsing with Docling** — replace bare `pdf-parse` for PDFs (tables/layout →
   Markdown), keep txt/md path.

### Next (structural quality)
4. **Hybrid search via ParadeDB `pg_search`** (BM25 + vector, RRF) — stays in Postgres.
5. **Structural/semantic chunking** on Docling output (Chonkie or a small custom
   splitter) instead of fixed characters.
6. **Memory technique upgrades (path A):** contradiction/supersede handling + memory
   `type` + optional temporal validity, in our existing tables.

### Later (scale / breadth)
7. **pgvectorscale** when a tenant corpus outgrows HNSW-in-RAM.
8. **Firecrawl** for web-page ingestion; **Unstructured/Tika** for exotic formats.
9. Re-evaluate **Mem0 (OSS on pgvector)** only if memory path A underdelivers.

### Avoid (for this product)
- Managed RAG/memory SaaS (Bedrock KB, Vectara, Pinecone, Zep Cloud) — breaks
  self-host + isolation + egress model.
- Wholesale framework adoption (LangChain/Letta as the spine) — fights the "small,
  readable, no framework machinery" strength.
- A second datastore (Qdrant/Weaviate) *until* Postgres+pgvectorscale+pg_search is a
  proven bottleneck.

---

## 4. One-line summary

Keep the boring, self-hosted Postgres core; the money is in **retrieval quality**
(rerank → hybrid → better parsing/chunking, measured by **Ragas**) and in **smarter
memory updates** (contradiction/temporal handling in our own tables) — all achievable
without adopting a managed service or a heavyweight framework, and all consistent with
Riwaq's isolation-by-default design.
