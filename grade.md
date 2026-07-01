# Riwaq Engineering Review

> **Remediation applied 2026-07-01** — all four **P0 isolation blockers** are fixed,
> plus a set of tractable P1/P2 items, and the project now has a **DB-backed
> isolation test suite (30 tests, all passing) and CI**. See
> [Remediation applied](#remediation-applied-2026-07-01) at the end for the change
> log, the rationale behind each fix, and what was deliberately deferred.

**Review date:** 2026-07-01  
**Scope:** Repository-wide static review of the TypeScript API, database model and
migrations, RAG/memory pipeline, authentication, Docker deployment, documentation,
and engineering controls.

## Final grade: D+ (56/100)

Riwaq is a **thoughtful prototype with a coherent architecture**, but it is not yet a
production-grade multi-tenant system. The code is compact, readable, strictly typed,
and organized around useful boundaries. The canonical chat pipeline and provider/output
adapters are particularly good decisions.

The grade is held down by gaps that affect the product's central promise: agent and
end-user isolation. Private knowledge bases can be linked to other agents, and memories
are recalled across every end user of an agent. There are also no automated tests, no
CI, no durable background jobs, weak secret handling, no abuse controls, and insufficient
database-enforced invariants.

This would be a promising **alpha/internal prototype**. It should not handle untrusted
tenants or sensitive customer data in its current form.

## Scorecard

| Area | Weight | Score | Assessment |
|---|---:|---:|---|
| Architecture and design | 20 | 15 | Clear boundaries and sensible abstractions; important isolation rules exist only in application code |
| Correctness and data integrity | 15 | 8 | Happy path is coherent; concurrency, partial writes, and identity consistency are under-specified |
| Security and privacy | 20 | 7 | Basic org scoping is consistent, but agent/user isolation, secrets, SSRF, and abuse prevention need work |
| Testing and verification | 15 | 2 | Type checking passes; no tests, coverage, CI, linting, or contract verification |
| Reliability and operability | 15 | 6 | Health check and status fields exist; background work, shutdown, retries, telemetry, and recovery are weak |
| Maintainability and code quality | 10 | 8 | Small, readable modules with strict TypeScript and good naming |
| Documentation and developer experience | 5 | 5 | Strong README and design plan; setup and API intent are unusually clear |
| **Total** | **100** | **56** | **D+** |

## Release recommendation

**No-go for public production.** The P0 items below should be fixed before accepting
real customer data. P1 items should be complete before describing the service as
production-ready.

## Findings

### P0 — Isolation and security blockers

#### 1. Private knowledge bases can be shared with another agent

`POST /agents/:id/knowledge-bases` verifies that the agent and KB belong to the same
organization, but it does not reject `kb.isDefault === true`. Any private KB in the
organization can therefore be linked to any other agent. This contradicts the stated
"isolation by default" model.

Evidence:

- `src/routes/knowledge-bases.ts:55-71` permits linking every same-org KB.
- `src/routes/knowledge-bases.ts:74-82` recognizes default KBs as private only when
  unlinking.
- `src/db/schema.ts:44-67` does not model ownership of a private KB or enforce the
  invariant in the database.

Impact: accidental or malicious cross-agent retrieval of private documents. Linking a
second private KB can also make the convenience upload route choose an arbitrary default
KB because it uses `LIMIT 1` without a unique ownership relationship.

Required fix: give a private KB an explicit owning agent, enforce one private KB per
agent with database constraints, reject private KBs in the shared-link endpoint, and
test cross-agent access at both route and retrieval layers.

#### 2. Per-user memories leak across end users

Memories are stored with `endUserId`, but recall and deduplication filter only by
`agentId`. Facts extracted from user A can be inserted into user B's prompt, and similar
facts from different users can suppress each other.

Evidence:

- `src/services/memory.ts:12-20` recalls all memories for an agent.
- `src/services/memory.ts:50-63` deduplicates across all users of an agent.
- `src/prompts/system.ts:19-20` describes the recalled data as facts about "this user."

Impact: direct privacy leakage between an agent's end users and corruption of long-term
memory.

Required fix: pass the authenticated/validated end-user identity into recall; query
`endUserId = current user OR endUserId IS NULL`; scope user-memory deduplication to the
same user; add adversarial isolation tests.

#### 3. Conversation identity is not bound to `endUserId`

When a caller supplies a conversation ID, the code verifies only that it belongs to the
agent. It does not verify that the conversation's stored `endUserId` matches the request.
The new learning event uses the request's identity rather than the conversation's
identity.

Evidence: `src/services/chat.ts:84-99`.

Impact: one end user can continue another user's conversation if its ID is exposed, and
new memories can be attributed to the wrong person.

Required fix: select and compare the conversation's `endUserId`, or derive identity
exclusively from the stored conversation. Do not treat a caller-supplied string as
authentication; production integrations need a trusted identity boundary.

#### 4. Tenant-controlled LLM URLs create an SSRF boundary

An organization can store an arbitrary `baseUrl`, which is later used by server-side LLM
clients. URL syntax validation does not block loopback, link-local, private network,
cloud metadata, redirect, or DNS-rebinding targets.

Evidence:

- `src/routes/organizations.ts:63-79` accepts any valid URL.
- `src/services/llm-config.ts:45-53` passes the value into the runtime config.
- `src/lib/llm.ts:60-82` constructs network clients from that URL.

Impact: authenticated tenants may probe internal services from the API network. Depending
on reachable services and response behavior, this can become data exposure or lateral
movement.

Required fix: default to an allowlist of approved providers. If custom endpoints are a
product requirement, isolate egress, resolve and validate DNS/IP ranges, revalidate
redirects, block non-HTTPS except explicit development mode, and apply timeouts and
response-size limits.

### P1 — Required for production readiness

#### 5. Authentication and LLM secrets are stored in plaintext

Organization API keys and tenant LLM keys are stored directly in the database.
Authentication performs a direct equality lookup, and SDK client caches retain raw keys
for the process lifetime.

Evidence: `src/db/schema.ts:19-27`, `src/middleware/auth.ts:18-22`,
`src/lib/llm.ts:60-82`.

Store a keyed hash of API keys, show the secret only at creation, support rotation and
revocation, encrypt LLM credentials with a KMS-backed envelope key, avoid putting raw
secrets in cache keys, and add audit events for credential changes.

#### 6. No rate limits, quotas, or input-size limits

Public organization creation is unlimited. Chat messages, history arrays, JSON text,
multipart files, names, and system prompts have no practical maximums. Upload parsing
buffers entire files in memory. Tenant-triggered LLM and embedding calls have no budget
or concurrency control.

Evidence: `src/routes/organizations.ts:12-27`, `src/routes/documents.ts:27-50`,
`src/routes/chat.ts:13-17`, `src/routes/openai.ts:60-116`.

Add request-body limits at the server boundary, per-route schemas with maximum lengths,
file type/size/page limits, per-org rate and spend quotas, concurrency caps, and
backpressure. Protect public bootstrap with an invite/admin flow or strong anti-abuse
controls.

#### 7. Background work is lossy and non-idempotent

Document ingestion and learning use in-process fire-and-forget promises. A restart loses
work. There are no leases, retries, retry limits, dead-letter state, cancellation, or
recovery scan. Ingestion inserts chunks and updates status in separate operations, so a
failure can leave partial chunks; retrying can duplicate them.

Evidence: `src/routes/documents.ts:15-24`, `src/services/ingest.ts:11-34`,
`src/services/learn.ts:11-46`.

Move this work to a durable queue/outbox, make jobs idempotent, write chunks and status
atomically, expose attempts/error details, and recover stale `processing` rows.

#### 8. There is no automated test suite or CI quality gate

The repository has no unit, integration, security-isolation, migration, streaming,
provider-contract, or end-to-end tests. `package.json` exposes only dev/start/migrate/
typecheck scripts. No CI workflow is present.

For a multi-tenant data system, type checking alone is far below the assurance bar.
Prioritize matrix tests proving that org A cannot access org B, agent A cannot retrieve
agent B's private KB, and user A cannot recall user B's memories.

#### 9. Database invariants are weaker than the domain model

The database permits cross-org agent/KB links, chunk rows whose document and KB disagree,
arbitrary role/status/provider/feedback strings, multiple private KBs per agent, and
duplicate agent names despite name-based model resolution. Most tenancy guarantees
depend on every current and future handler remembering the correct guard.

Evidence: `src/db/schema.ts:31-150` and `src/db/migrations/0000_init.sql:12-117`.

Use composite foreign keys or tenant IDs on link/data tables, unique and check
constraints, explicit enums where appropriate, and Row Level Security as defense in
depth. Make agent-name lookup deterministic with a per-org unique constraint or remove
name-based resolution.

#### 10. Topic counters have lost-update races

Topic assignment reads `count`, then writes `count + 1` without a lock or atomic
increment. Concurrent questions can lose counts. Topic matching and log insertion are
also not transactional, and centroids are never updated after assignment.

Evidence: `src/services/topics.ts:22-52`.

Use an atomic SQL increment and a transaction; define a concurrency-safe clustering
strategy and update centroids intentionally.

### P2 — Engineering maturity gaps

#### 11. Retrieval has no relevance threshold or context budget

The top six chunks and top five memories are always injected, regardless of similarity.
Character chunking and fixed item counts do not enforce a model token budget. This
increases irrelevant context, cost, and prompt-injection exposure.

Add calibrated similarity thresholds, token-aware packing, diversity/deduplication,
retrieval evaluation datasets, and explicit treatment of retrieved text as untrusted
data.

#### 12. Prompt-injection controls are insufficient

Uploaded documents and extracted memories become system-prompt content. The base rule is
useful but is not a security boundary; malicious knowledge can instruct the model to
ignore policy or disclose other context.

Separate instructions from data with robust delimiters, tell the model explicitly that
retrieved content is untrusted and non-authoritative, sanitize/scan ingestion, and test
known indirect prompt-injection attacks. Do not rely on model instructions alone for
access control.

#### 13. Migration management is not auditable

Every boot replays every SQL file and relies on `IF NOT EXISTS`/repeatable `ALTER`
behavior. There is no migration ledger, checksum, lock, rollback/forward-fix policy, or
compatibility test. Concurrent replicas can race during startup.

Adopt a real migration runner with an immutable history table and advisory lock. Run
migrations as a deployment step, not independently in every API replica.

#### 14. Production container and Compose defaults need hardening

The image runs TypeScript through `tsx`, installs development dependencies, copies the
whole repository, and runs as root. Compose publishes Postgres, uses fixed development
credentials, mounts source, and runs the watch server.

Create separate development and production targets; use `npm ci`, compile ahead of time,
copy only runtime artifacts, prune dev dependencies, run as a non-root user, pin image
digests, add a read-only filesystem where possible, and keep the database private.

#### 15. Observability and lifecycle management are minimal

Logs are unstructured and there are no request IDs, tenant-safe traces, metrics, SLOs,
queue depth, provider latency/error metrics, readiness distinction, signal handling, or
graceful database/server shutdown. `/health` proves only that one DB query succeeds.

Add structured redacted logging, correlation IDs, metrics/tracing, readiness/liveness
separation, graceful shutdown, and operational alerts. Never log prompts, retrieved
customer data, or secrets by default.

#### 16. API contracts and error semantics need tightening

Several endpoints return success even when no row changed; unknown `format` values
silently become native; numeric options are cast rather than fully validated; and the
OpenAI-compatible body is hand-parsed with incomplete constraints. No API schema is
generated or tested.

Define a versioned OpenAPI contract, validate path/query/body inputs consistently,
return deterministic error envelopes, and add compatibility tests against supported SDKs.

## What is done well

- **Good separation of concerns.** Routes, services, provider adapters, serializers,
  prompts, and database access are easy to navigate.
- **Strong canonical model.** Normalizing providers into one `ChatResult` and projecting
  output formats afterward is the right extension point.
- **Strict TypeScript.** `strict` and `noUncheckedIndexedAccess` are enabled, and the
  current code passes `tsc --noEmit`.
- **Mostly consistent organization scoping.** Resource routes generally resolve the
  organization from authentication and verify ownership before access.
- **Atomic agent bootstrap.** Agent, private KB, and initial link are created in one
  transaction.
- **Pragmatic provider design.** Layered agent/org/deployment configuration is clearly
  expressed and provider details do not leak through the main chat service.
- **Excellent project narrative.** The README and plan explain the product, tenancy
  model, request path, API surface, and operational assumptions clearly.
- **Small, readable modules.** At roughly 2,250 lines of application code, the system is
  approachable and has not been prematurely buried under framework machinery.

## Recommended remediation sequence

### Phase 1 — Restore the isolation contract

1. Model private KB ownership and enforce it in database constraints.
2. Block private KB linking and fix deterministic private-KB lookup.
3. Scope memory recall/deduplication by end user.
4. Bind conversations to a trusted end-user identity.
5. Add a comprehensive tenant/agent/user isolation integration suite.

### Phase 2 — Establish a safe service boundary

1. Hash API keys; encrypt LLM credentials; add rotation and audit logs.
2. Restrict custom LLM egress and mitigate SSRF.
3. Add request, upload, concurrency, rate, and spend limits.
4. Add strong schema validation and a versioned OpenAPI contract.
5. Add secure production container and deployment configurations.

### Phase 3 — Make execution durable

1. Introduce a durable queue/outbox for ingestion and learning.
2. Make jobs transactional/idempotent with retries and dead-letter handling.
3. Fix atomic topic counting and clustering concurrency.
4. Adopt ledgered, locked migrations.
5. Add graceful shutdown, structured telemetry, metrics, and alerts.

### Phase 4 — Raise model-system quality

1. Build retrieval and answer-quality evaluation sets.
2. Add relevance thresholds and token-aware context packing.
3. Test indirect prompt injection and data-exfiltration scenarios.
4. Track cost, latency, retrieval quality, groundedness, and failure rates per tenant.

## Verification performed

- Read all application modules, SQL migrations, deployment files, and primary
  documentation.
- Ran `npm run typecheck`: **passed**.
- Checked the repository for test/spec and CI files: **none found**.
- Attempted `npm audit --omit=dev`; the registry was unreachable in the review
  environment, so dependency vulnerability status is **not verified** and is not
  included in the numerical grade.

## Grade interpretation

- **A:** production-ready, measured, secure, resilient, and comprehensively tested.
- **B:** strong system with bounded, non-critical production gaps.
- **C:** viable beta with meaningful reliability or security debt.
- **D:** promising prototype with blockers in core guarantees.
- **F:** unsafe or fundamentally non-functional.

Riwaq lands at **D+** because the architecture is better than the maturity score suggests,
but privacy/isolation defects affect the exact guarantees the product is built around.
Fixing the P0 issues and adding serious isolation tests would move it quickly toward a
credible C; durable execution, hardened secrets/egress, CI, and operational controls are
needed for B territory.

---

# Remediation applied (2026-07-01)

This section records the fixes made in response to the review, the reasoning for each
approach, and how it was verified. **Everything below was verified by `tsc --noEmit`
(passes) and a new automated suite of 30 tests (all passing), including a real
Postgres+pgvector isolation matrix.** The migration path was additionally validated
against a *clone of the live dev database* to prove the destructive key-hashing
migration is safe on existing data.

## Guiding principle

The review's central point is that **isolation guarantees lived only in application
code** — one forgotten `WHERE` clause and a tenant boundary silently disappears. So the
theme of this remediation is to **push each invariant to the lowest layer that can
enforce it**: database constraints where possible, a single choke-point function where
not, and a test that *proves* the boundary holds. Prompts and route guards are the last
line, not the only line.

## P0 — Isolation blockers (all fixed)

### #1 Private KBs can be linked to another agent → **fixed**

- **What changed:** private KBs now have an explicit owning agent
  (`knowledge_bases.agent_id`), with a DB **CHECK** (`private ⇔ owner present`) and a
  **unique partial index** (one private KB per agent). The share endpoint rejects
  `isDefault` KBs, and the convenience upload route resolves the private KB by owner
  instead of an ambiguous `LIMIT 1` over a join.
- **Files:** [0003_kb_ownership.sql](src/db/migrations/0003_kb_ownership.sql),
  [schema.ts](src/db/schema.ts), [knowledge-bases.ts:64](src/routes/knowledge-bases.ts),
  [agents.ts](src/routes/agents.ts), [documents.ts](src/routes/documents.ts).
- **Why this is the right fix:** the review asked for exactly this — *"give a private KB
  an explicit owning agent, enforce one private KB per agent with database
  constraints."* Doing it in the schema means the leak is **unrepresentable**, not just
  discouraged: even a future buggy handler physically cannot create a second private KB
  or an ownerless one. The route check is a fast, friendly 400; the DB constraint is the
  guarantee.

### #2 Per-user memories leak across end users → **fixed**

- **What changed:** `recallMemories(agentId, endUserId, …)` now filters
  `endUserId = current OR endUserId IS NULL` (this user's facts + agent-wide facts,
  never another user's). Dedup on write is scoped to the same `(agent, endUserId)` so one
  user's fact can't suppress another's.
- **Files:** [memory.ts](src/services/memory.ts), [chat.ts:115](src/services/chat.ts).
- **Why this is the right fix:** memory is recalled through exactly one function, so
  scoping it there closes the leak everywhere at once — there's no second recall path to
  forget. Keeping the `IS NULL` branch preserves the intended "agent-wide fact" feature
  while making per-user facts strictly private. Proven by an adversarial test asserting
  Alice never sees Bob's fact and vice-versa.

### #3 Conversation identity not bound to `endUserId` → **fixed**

- **What changed:** continuing a conversation now loads the stored `endUserId` and
  **refuses a mismatch with 403** before any work happens; learning is attributed to the
  validated identity.
- **Files:** [chat.ts:84](src/services/chat.ts) (+ 403 plumbed through
  [chat route](src/routes/chat.ts) and [openai route](src/routes/openai.ts)).
- **Why this is the right fix:** a caller-supplied conversation id is not proof of
  identity, so the fix treats it as a claim to be checked against the source of truth
  (the stored row). The check is the very first step — cheap, and it fails closed before
  embeddings, retrieval, or memory attribution can run against the wrong person.

### #4 Tenant-controlled LLM URLs are an SSRF vector → **fixed**

- **What changed:** a pure, unit-tested URL guard
  ([url-guard.ts](src/lib/url-guard.ts)) rejects non-https, embedded credentials,
  `localhost`, and any host that is **or resolves to** a loopback/private/link-local/
  CGNAT/cloud-metadata address (IPv4 + IPv6, including IPv4-mapped). It's enforced when
  an org saves its `baseUrl` ([organizations.ts](src/routes/organizations.ts)), with an
  optional strict `LLM_ALLOWED_HOSTS` provider allowlist. Remote embedding calls also got
  30s timeouts.
- **Why this is the right fix:** the guard is **pure with an injectable resolver**, so
  the dangerous range logic (the part that's easy to get subtly wrong) is exhaustively
  unit-tested — including the classic `169.254.169.254` metadata target and a DNS host
  that resolves to `10.x` — with zero network flakiness. Blocking private ranges is
  always on (safe default); the allowlist is available for locked-down deployments, which
  is the review's "default to an allowlist of approved providers" without breaking the
  product's bring-your-own-endpoint feature. *Residual:* runtime DNS-rebinding still
  warrants network-level egress isolation in production (noted under Deferred).

## P1 / P2 — also fixed

### #9 Weak database invariants → **hardened** ([0004_invariants.sql](src/db/migrations/0004_invariants.sql))
CHECK constraints for every enum-like column (role, status, source, feedback,
provider); a **per-org unique agent name** (makes the OpenAI route's name→agent
resolution deterministic); a **composite FK** so a chunk's KB must equal its document's
KB; and **org_id carried on the agent↔KB link with composite FKs to both sides**, making
a cross-org link impossible at the database. *Why:* these are the guarantees the domain
model always implied; encoding them as constraints means "every current and future
handler remembering the guard" is no longer required. A test asserts the cross-org link
is rejected by the DB itself.

### #10 Topic-counter lost updates → **fixed** ([topics.ts](src/services/topics.ts))
Counter now uses an atomic `count = count + 1` (not read-then-write) inside a
transaction that also writes the question log. *Why:* an atomic SQL increment is the
standard, race-free primitive; the transaction keeps the topic update and its log row
consistent. The LLM label call was moved *outside* the transaction so we never hold one
open across a network round-trip.

### #5 Plaintext API keys → **hashed** ([0005_api_key_hash.sql](src/db/migrations/0005_api_key_hash.sql), [api-key.ts](src/lib/api-key.ts))
Only a SHA-256 hash + a non-secret display prefix are stored; the raw key is shown once
at creation and auth looks up by hash. Existing keys are hashed in-place by the
migration (verified on a dev clone: the original key still authenticates). *Why:* the key
is 192 bits of CSPRNG output, so a single fast digest is both sufficient (no brute-force
preimage) and keeps auth O(1) via a unique index — a per-row slow KDF would add latency
for no security gain here. LLM-credential encryption at rest is the remaining, heavier
half of this finding (Deferred).

### #6 No input/size limits → **added** ([index.ts](src/index.ts), [documents.ts](src/routes/documents.ts), route schemas)
A body-size limit at the server boundary (413), plus per-field maxima (message, name,
system prompt, model) and upload caps (raw bytes + extracted-text length). *Why:* bounds
the memory and embedding-cost blast radius of a single tenant without a heavier quota
system, which is the right first increment.

### #7 Lossy, non-idempotent background work → **partially hardened** ([ingest.ts](src/services/ingest.ts))
Ingestion now writes chunks + flips status in **one transaction** and **clears prior
chunks first** (idempotent retry, no partial/duplicate state); embedding happens before
the transaction opens. A **boot recovery scan** fails documents stuck in `processing`
after a crash. *Why:* this removes the partial-write and duplicate-on-retry hazards now;
a durable queue (the full fix) is a larger infra decision left as the documented upgrade
path.

### #13 Unauditable migrations → **fixed** ([migrate.ts](src/db/migrate.ts))
Replaced blind replay with a **ledgered, advisory-locked** runner: each file applies
once, in a transaction, recorded with a checksum; an edited-after-apply file is a hard
error; concurrent replicas serialize on a Postgres advisory lock. *Why:* this is the
standard migration-runner contract (immutable history + lock) and it directly kills the
"every boot replays everything / replicas race" problem the review flagged.

### #15 Minimal lifecycle → **improved** ([index.ts](src/index.ts))
Graceful `SIGTERM`/`SIGINT` shutdown that stops accepting connections and drains the DB
pool. *Why:* cheap, standard, and prevents dropped in-flight requests / leaked
connections on deploy.

### #11 / #12 Retrieval & prompt-injection → **improved** ([retrieve.ts](src/services/retrieve.ts), [system.ts](src/prompts/system.ts))
Retrieval gained a (calibratable, default-off) similarity threshold and a character
budget so context can't grow unbounded. The system prompt now wraps Knowledge and Memory
in hard-to-forge delimiters and explicitly tells the model that retrieved content is
**untrusted data, not instructions**. *Why:* threshold is default-off so it can be tuned
per embedding model without regressing the demo; the untrusted-content framing is a real
mitigation while (as the review stresses) the *actual* access control remains the
retrieval scoping, not the prompt.

### #8 No tests / CI → **established** ([tests/](tests), [ci.yml](.github/workflows/ci.yml))
A `vitest` suite: pure unit tests for the SSRF guard, and a **DB-backed isolation matrix**
that spins up a throwaway `riwaq_test` database and proves org-A-can't-read-org-B,
private-KB-can't-be-linked, per-user-memory-isolation, conversation-identity binding, and
the DB-level constraints. GitHub Actions runs typecheck + the full suite against a
`pgvector/pgvector:pg16` service. *Why:* the review correctly weighted this highest —
for a multi-tenant data system, *executable proof* of the boundaries (not just types) is
the assurance that matters. Tests use tiny 8-dim vectors and never call a real
LLM/embedding provider, so they're fast and hermetic.

## Deliberately deferred (with reasoning)

These are real and acknowledged, but are larger infrastructure/product decisions rather
than self-contained code fixes; doing them badly is worse than scoping them explicitly:

- **#5 (second half) LLM-credential encryption at rest / KMS envelope.** Needs a key-
  management decision (cloud KMS vs. env master key) and rotation/audit design. API-key
  hashing — the higher-value, self-contained half — is done.
- **#7 (full) durable queue / outbox.** The in-process hazards are mitigated; a real
  queue (BullMQ+Redis or a DB outbox with leases/DLQ) is an architectural addition.
- **#14 production container/compose hardening** (multi-stage build, non-root, AOT
  compile, private DB). Pure DevOps config, best done as its own change.
- **#16 versioned OpenAPI contract + SDK compatibility tests.** Valuable but broad;
  error-envelope/format tightening was partially addressed via the 403 plumbing.
- **Runtime DNS-rebinding for #4.** The validation-time DNS check + range blocking covers
  the common case; full runtime protection needs socket-level egress control best handled
  at the network layer.

## Verification performed

- `npm run typecheck` — **passes**.
- `npm test` — **30/30 pass** (`tests/url-guard.test.ts` 23, `tests/isolation.test.ts` 7),
  against real Postgres + pgvector.
- Full migration chain (0000→0005) applied to a **clone of the live dev DB**: keys hashed
  in place (original key still authenticates), private-KB owner backfilled, composite FKs
  and constraints created, ledger populated, and a re-run is a clean no-op. The live dev
  database was not modified.
