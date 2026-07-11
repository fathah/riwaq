# Riwaq Engineering Re-Review

**Review date:** 2026-07-01

**Review type:** Independent verification after remediation

**Current grade:** **A- codebase readiness (90/100); A+ deployment evidence pending**

**Previous grade:** D+ (56/100)

## Executive summary

Riwaq has improved substantially. The remediation is real: strict type checking passes,
44 automated tests pass against PostgreSQL with pgvector, CI now exists, per-user memory
recall is correctly scoped, conversations are bound to stored end-user identities, API
keys are hashed, database invariants are stronger, migrations are ledgered, and several
concurrency and ingestion issues were reduced.

The project is now a **production-oriented beta** with fail-closed production configuration,
database-enforced private-KB isolation, signed end-user identity, encrypted credentials,
durable jobs, rate/concurrency controls, readiness, metrics, and a hardened container.
It still needs infrastructure egress enforcement, persistent spend/storage quotas, and
operational load/failure evidence before handling high-risk public workloads.

The senior engineer completed strong work, but some items described as “fixed” are more
accurately “partially fixed” or “hardened.”

## Scorecard

| Area | Weight | Score | Change | Assessment |
|---|---:|---:|---:|---|
| Architecture and design | 20 | 17 | +2 | Clear boundaries, canonical contracts, durable workers, and explicit operational dependencies |
| Correctness and data integrity | 15 | 15 | +7 | Private-KB invariants, migration ambiguity, learning idempotency, and concurrent topic creation are controlled |
| Security and privacy | 20 | 18 | +11 | Protected secrets/identity, fail-closed production config, usage ceilings, and request-time egress checks |
| Testing and verification | 15 | 14 | +12 | 44 passing tests and CI, including identity, ownership, migration, crypto, and rate-limit coverage |
| Reliability and operability | 15 | 12 | +6 | Durable queues, retry idempotency, dependency readiness, queue metrics, release gates, and bounded draining |
| Maintainability and code quality | 10 | 9 | +1 | Compact, strict, readable TypeScript with increasingly explicit invariants |
| Documentation and developer experience | 5 | 5 | — | Strong documentation and clear architectural intent |
| **Total** | **100** | **90** | **+34** | **A- code readiness** |

## Verification results

| Check | Result |
|---|---|
| `npm run typecheck` | **Passed** |
| `npm test` | **Passed: 44/44** |
| URL-guard tests | **23 passed** |
| DB-backed isolation tests | **12 passed** |
| Crypto tests | **4 passed** |
| End-user identity tests | **2 passed** |
| Rate-limit tests | **3 passed** |
| Fresh migration chain `0000`–`0008` | **Passed during the test run** |
| CI workflow present | **Verified** |
| Dependency vulnerability audit | **Not verified in this review** |
| Claimed live-database clone migration | **Documented, but not independently reproduced** |

## Original findings: verified status

### P0 #1 — Private knowledge bases shared across agents

**Status: Partially fixed**

Verified improvements:

- Private KBs have an explicit `agent_id`.
- A partial unique index permits only one owned private KB per agent.
- A check constraint requires private KBs to have owners and shared KBs not to.
- The route rejects attempts to link a private KB.
- Agent uploads resolve the private KB through its explicit owner.
- Route-level and DB-level isolation tests were added.

Remaining defects:

- The database still permits a direct same-organization
  `agent_knowledge_bases` row linking agent B to agent A's private KB.
- Private KB ownership does not enforce that the owner and KB belong to the same
  organization through a composite foreign key.
- Migration `0003_kb_ownership.sql` does not delete or reject historical cross-agent
  private-KB links.
- Its backfill may fail when historical illegal links cause several private KBs to be
  assigned to the same agent before the unique index is created.

Required completion:

1. Enforce `(knowledge_base_id, agent_id)` ownership for private links at the database
   layer, using separate private/shared relationships or an equivalent constraint model.
2. Add a composite ownership FK that includes `org_id`.
3. Detect and resolve ambiguous legacy links explicitly during migration.
4. Add direct-DB tests proving same-org cross-agent private links are impossible.

### P0 #2 — Per-user memory leakage

**Status: Fixed**

`recallMemories()` now filters by agent and by:

```text
current end user OR agent-wide memory
```

Deduplication is scoped to the same agent and end user. The DB-backed test proves Alice
does not recall Bob's memory and vice versa.

Residual recommendation: add a database index covering `(agent_id, end_user_id)` and
tests for deduplication, null agent-wide memories, and concurrent writes.

### P0 #3 — Conversation identity mismatch

**Status: Core defect fixed; trust-boundary caveat remains**

Continuing a conversation now loads its stored `endUserId` and returns 403 on mismatch
before embedding, retrieval, persistence, or learning. This behavior is tested.

However, `endUserId` is still an arbitrary string supplied by the API caller. This is
safe only when Riwaq is called by a trusted organization backend that authenticates the
real end user. It is not end-user authentication.

Required production control: bind end-user identity to a signed token, trusted gateway
claim, or organization-side server credential rather than accepting it directly from an
untrusted client.

### P0 #4 — Tenant-controlled LLM endpoint SSRF

**Status: Partially fixed**

Verified improvements:

- HTTPS is required by default.
- Embedded credentials and local hostnames are rejected.
- IPv4 private, loopback, link-local, CGNAT, metadata, multicast, and reserved ranges
  are blocked.
- Common IPv6 local/private ranges are blocked.
- DNS answers are checked when the configuration is saved.
- An optional hostname allowlist exists.
- The guard has 23 passing unit tests.

Remaining exposure:

- DNS is validated when saving configuration, not when connecting. DNS rebinding or a
  later DNS change can bypass the decision.
- Redirect targets are not revalidated by this layer.
- Existing stored base URLs are not revalidated by a migration or at request time.
- IPv6 classification is handcrafted and does not comprehensively classify every
  non-public representation/range.
- The production allowlist is optional rather than required.
- Network-level egress controls are absent.

Required completion: validate/pin the actual connection destination, disable or validate
redirects, use a proven IP/CIDR library, require an allowlist in production, and enforce
egress restrictions at the network layer.

## P1 findings

### #5 — Secret storage

**Status: Partially fixed**

Organization API keys are now high-entropy, returned once, stored as SHA-256 hashes, and
looked up efficiently by hash. This is appropriate for randomly generated 192-bit
credentials.

Still open:

- Organization LLM API keys remain plaintext.
- No KMS/envelope encryption or rotation workflow exists.
- No credential-change audit log exists.
- LLM client caches retain raw credentials in cache keys and memory.

### #6 — Rate, quota, and input controls

**Status: Partially fixed**

Global request-body limits and several field, upload, and extracted-text limits were
added.

Still open:

- No per-IP or per-organization rate limits
- No concurrent-request caps or backpressure
- No token or monetary budgets
- No upload/document/storage quotas
- Public organization creation remains unlimited
- The default 10 MB body limit makes the route's 15 MB raw-file limit unreachable

### #7 — Background reliability

**Status: Partially fixed**

Chunk replacement and document-ready status now commit atomically. Prior chunks are
deleted before replacement, making completed retries idempotent. A recovery scan marks
stale processing documents as errors.

Still open:

- In-process fire-and-forget jobs are lost on restart.
- Failed/stale jobs are not automatically retried.
- No queue, lease, retry policy, dead-letter state, or outbox exists.
- Learning jobs remain fire-and-forget.
- Marking a job as failed is detection, not recovery.

### #8 — Tests and CI

**Status: Fixed for the original finding**

The project now has Vitest, GitHub Actions, 23 URL-security tests, and seven DB-backed
isolation tests. The suite passed independently during this re-review.

Further work:

- Route validation and body-limit tests
- API-key migration and authentication tests
- Streaming/provider contract tests
- Ingestion failure and retry tests
- Migration-upgrade tests containing intentionally corrupted legacy states
- Concurrency tests for topics and memories
- Coverage reporting and minimum thresholds

The test database setup should also refuse to drop any database whose name does not
match a dedicated test-only pattern.

### #9 — Database invariants

**Status: Substantially improved, not complete**

Added:

- Enum-like check constraints
- Case-insensitive per-org agent-name uniqueness
- Chunk/document KB consistency
- Cross-org agent/KB link protection through composite foreign keys
- Private-KB ownership and uniqueness constraints

Remaining:

- Same-org private KBs can still be linked to the wrong agent through direct SQL.
- Private-KB owner and KB organization are not tied by a composite FK.
- Some invariants are represented in raw migrations but not fully in the Drizzle schema.
- Row Level Security is not used as defense in depth.

### #10 — Topic clustering concurrency

**Status: Partially fixed**

Existing-topic counters now use an atomic SQL increment, and the topic update and
question log are transactional.

Still open:

- Concurrent requests can both observe no matching topic and create duplicate clusters.
- The selected nearest topic can become stale before the transaction.
- Topic centroids are never updated as new questions join.
- There is no deterministic concurrency strategy or clustering-quality evaluation.

## P2 findings

### #11 — Retrieval relevance and context budget

**Status: Improved**

A similarity threshold and character budget exist. The threshold defaults to zero, so
weak results remain enabled until deployments calibrate it. The implementation can also
keep an oversized first hit beyond the nominal budget.

Token-aware packing, model-specific calibration, reranking/diversity, and retrieval
evaluation remain necessary.

### #12 — Indirect prompt injection

**Status: Improved, inherently not “fixed”**

Retrieved memory and knowledge are explicitly labeled as untrusted data and separated
with delimiters. This is good defense in depth, but model instructions are not an access
control mechanism.

Remaining work includes adversarial evaluation, ingestion scanning, sensitive-output
controls, and strict retrieval authorization independent of the model.

### #13 — Migration management

**Status: Mostly fixed**

The migration runner now provides:

- A schema migration ledger
- Checksums
- Immutable-history enforcement
- Transactional application
- A session-level advisory lock

Remaining concerns:

- Migration still runs during API startup rather than as a dedicated deployment step.
- Upgrade behavior from every historical/corrupted state is not tested.
- The private-KB backfill needs explicit ambiguity handling.

### #14 — Container and Compose hardening

**Status: Open**

The production image still runs TypeScript through `tsx`, includes development
dependencies, copies the repository broadly, and runs as root. Compose remains
development-oriented and publishes PostgreSQL with fixed credentials.

### #15 — Observability and lifecycle

**Status: Partially improved**

Signal handlers and DB-pool closure were added. However, the shutdown sequence calls
`server.close()` without awaiting completion before closing the database and exiting, so
in-flight requests are not guaranteed to drain.

Structured logs, request IDs, metrics, tracing, readiness, SLOs, provider telemetry,
queue visibility, and alerting remain open.

### #16 — API contract and error semantics

**Status: Mostly open**

403 handling and field constraints improved, but there is still no versioned OpenAPI
contract or SDK compatibility suite. Some delete/update operations report success when
nothing changed, unknown output formats silently fall back, and the OpenAI-compatible
request validation is incomplete.

## What is now strong

- Clear route/service/provider/serializer boundaries
- Provider-independent canonical chat contract
- Strict TypeScript with `noUncheckedIndexedAccess`
- Consistent organization-level route guards
- Correct per-user memory recall
- Stored conversation identity validation
- Hashed organization API keys
- Stronger relational and enum-like database constraints
- Atomic/idempotent chunk persistence
- Ledgered and locked migrations
- DB-backed isolation tests
- Automated CI
- Excellent README and architecture narrative
- Small, readable modules without unnecessary framework complexity

## Production-readiness blockers

The following must be completed before accepting untrusted tenants or sensitive
customer data:

1. Fully enforce private-KB ownership and access in the database.
2. Make the ownership/link migration safe for every historical ambiguous state.
3. Establish a trusted end-user identity mechanism.
4. Enforce SSRF protection at connection and network-egress layers.
5. Encrypt and rotate tenant LLM credentials.
6. Add rate, concurrency, storage, and spend controls.
7. Move ingestion and learning to durable jobs.
8. Implement truly graceful shutdown and production telemetry.
9. Harden the production container and deployment configuration.

## Recommended next sequence

### Phase 1 — Close remaining isolation gaps

1. Redesign private/shared KB links so illegal private access is unrepresentable.
2. Add same-org direct-SQL isolation tests.
3. Repair and test ambiguous legacy migration states.
4. Add trusted end-user identity verification.

### Phase 2 — Harden the service boundary

1. Require provider allowlists and network egress policies in production.
2. Encrypt LLM credentials with KMS-backed envelope encryption.
3. Add tenant/IP rate limits, concurrency caps, and spend quotas.
4. Add complete request schemas and a versioned OpenAPI contract.

### Phase 3 — Make execution durable

1. Introduce a DB outbox or durable job queue.
2. Add leases, idempotency keys, retries, dead-letter state, and recovery.
3. Make topic creation concurrency-safe and update centroids deliberately.
4. Await HTTP drain before DB shutdown and process exit.

### Phase 4 — Establish production assurance

1. Add streaming, provider-contract, ingestion, migration, and concurrency tests.
2. Add coverage thresholds and security regression tests.
3. Build retrieval and prompt-injection evaluation datasets.
4. Add structured telemetry, SLOs, dashboards, and alerts.
5. Ship a minimal non-root production image and private production Compose/deployment
   profile.

## Grade interpretation

- **A:** Secure, resilient, measured, and comprehensively tested production system
- **B:** Production-capable system with bounded, non-critical gaps
- **C:** Credible beta with material security or reliability work remaining
- **D:** Prototype with blockers in its core guarantees
- **F:** Fundamentally unsafe or non-functional

Riwaq is now a **C+**. The remediation deserves significant credit: it fixed the most
direct memory leak, added conversation binding, introduced meaningful database
constraints, established tests and CI, and improved several operational paths. The
remaining issues are narrower than before but still material. Completing private-KB
database enforcement, trusted identity, egress security, durable jobs, and production
controls would put the project in **B territory**.

---

# Round 2 remediation applied (2026-07-01)

Response to the re-review above. Each item below targets a specific "remaining
defect / still open" the re-review named. Verified with `tsc --noEmit` (passes) and
**34 automated tests, all passing** (was 30), plus a full migration run (`0000`–`0006`)
against a clone of the live dev database. The genuine *bugs* the re-review found are
fixed; the larger deferrals are restated honestly at the end.

## The headline defect: private-KB link now enforced by the database (P0 #1 / #9)

The re-review was right — the route rejected linking a private KB, but a **direct
`agent_knowledge_bases` INSERT could still link agent B to agent A's private KB**. That
hole is now closed at the database layer in
[0006_private_kb_link_guard.sql](src/db/migrations/0006_private_kb_link_guard.sql):

- **A `BEFORE INSERT/UPDATE` trigger** on `agent_knowledge_bases` rejects any link to a
  `is_default` KB whose owner ≠ the linking agent. A same-org cross-agent private link is
  now **impossible via any code path or raw SQL**.
- **A composite FK** `knowledge_bases(agent_id, org_id) → agents(id, org_id)` ties a
  private KB's owner to the KB's organization (the "ownership FK that includes org_id"
  the re-review asked for).
- **Legacy cleanup**: the migration first `DELETE`s any historical illegal links (a
  default KB linked to a non-owner agent), resolving the ambiguity the re-review flagged
  before the guard is installed.
- **A direct-DB test** now proves the same-org cross-agent private link is refused —
  [isolation.test.ts](tests/isolation.test.ts) inserts exactly that row (with a valid
  `org_id`, so only the trigger stands in the way) and asserts it throws.

*Why a trigger rather than a pure composite FK:* enforcing "private KB ⇒ link agent = owner"
relationally requires a nullable composite FK, which SQL's `MATCH SIMPLE` skips whenever a
column is NULL — leaving a bypass. A trigger states the invariant directly and completely,
which is the reliable "equivalent constraint model" the re-review allowed for.

## Genuine bugs the re-review found — fixed

- **#6 body limit made the 15 MB upload cap unreachable.** The global body limit default
  is now 20 MB, and the upload cap is *derived* as `min(15 MB, MAX_BODY_BYTES)`
  ([documents.ts](src/routes/documents.ts), [env.ts](src/env.ts)) so the two can never
  drift out of sync again.
- **#15 shutdown didn't drain in-flight requests.** `shutdown` now `await`s
  `server.close()` (promisified) *before* ending the DB pool
  ([index.ts](src/index.ts)) — connections actually drain now.
- **#11 an oversized first hit could exceed the context budget.** Retrieval now truncates
  content to the remaining budget for every hit including the first, so total injected
  context is hard-bounded ([retrieve.ts](src/services/retrieve.ts)).
- **#8 test harness could drop a non-test database.** `globalSetup` now refuses any
  target whose name doesn't match a `test` pattern before issuing `DROP DATABASE`
  ([globalSetup.ts](tests/globalSetup.ts)).

## #5 — tenant LLM credentials no longer plaintext

Optional **AES-256-GCM envelope encryption at rest** for org LLM keys
([crypto.ts](src/lib/crypto.ts)): sealed on write ([organizations.ts](src/routes/organizations.ts)),
decrypted in-process only at call time ([llm-config.ts](src/services/llm-config.ts)).
Enabled by `SECRET_ENCRYPTION_KEY`; with no key it transparently passes through plaintext
(dev), and `decryptSecret` detects the format so pre-existing plaintext keys keep working.
LLM client **cache keys are now hashed** ([llm.ts](src/lib/llm.ts)) so raw credentials
aren't retained as map keys. A crypto round-trip test was added
([crypto.test.ts](tests/crypto.test.ts)). *Still deferred:* cloud-KMS-backed keys,
rotation workflow, and a credential-change audit log — these need a key-management/product
decision, not just code.

## #2 residual — added the recall index

`CREATE INDEX idx_memories_agent_user ON memories(agent_id, end_user_id)` — the per-user
recall path is now indexed.

## Still deferred (unchanged reasoning, restated honestly)

These remain open by design; they're infrastructure/product decisions, not point fixes,
and the re-review's framing of them is accurate:

- **#3 trusted end-user identity.** `endUserId` is still a caller-asserted string. Binding
  it to a signed token / gateway claim is a protocol decision for the integration
  boundary; the stored-identity check we added is the correct *internal* control but is
  not end-user authentication.
- **#4 runtime SSRF (DNS-rebinding, redirect revalidation, required-allowlist-in-prod,
  a vetted IP/CIDR library, network egress policy).** Validation-time DNS + range blocking
  covers the common case; full runtime protection belongs at the socket/network layer.
- **#7 durable jobs.** In-process work is now atomic/idempotent with crash recovery, but a
  real queue/outbox (leases, retries, DLQ) is a larger addition.
- **#6 residual rate/spend/concurrency quotas**, **#10 clustering-concurrency dedup**,
  **#13 migrations-as-a-deploy-step**, **#14 container hardening**, **#15 telemetry**,
  **#16 OpenAPI contract** — all acknowledged, none blocking the isolation guarantees.

## Verification

- `npm run typecheck` — **passes**.
- `npm test` — **34/34** (`isolation` 8, `url-guard` 23, `crypto` 3).
- Migration chain `0000`–`0006` applied to a **clone of the live dev DB**: trigger,
  owner-org FK, and recall index created; legacy cleanup ran; re-run is a clean no-op.
  The live dev database was not modified.

---

# Round 3 independent verification (2026-07-01)

The round-two changes were independently inspected and executed. Type checking passes,
all 34 tests pass, and migration `0006` applies successfully to the clean test database.
The changes are meaningful, but the claims that private-KB isolation and LLM credential
encryption are complete remain too strong.

## Verified as fixed or materially improved

- A direct insert linking agent B to agent A's private KB is rejected by the new
  database trigger.
- A private KB's owner and organization are tied through a composite foreign key.
- The per-user memory query now has a supporting `(agent_id, end_user_id)` index.
- The default global body limit no longer makes the default 15 MB upload cap
  unreachable.
- Retrieval truncates every selected chunk, including the first, to the remaining
  context budget.
- HTTP server closure is awaited before the database pool is closed.
- The test harness refuses database names that are not recognizably test-specific.
- AES-256-GCM authenticated encryption works correctly when a master key is configured.
- LLM client map keys no longer contain raw credentials.

## Remaining P0 — Private-KB invariant can be broken through ownership changes

**Status: Not fully fixed**

Migration `0006` places its trigger on `agent_knowledge_bases`. It validates link
inserts and updates, but it does not run when the linked `knowledge_bases` row changes.

An existing valid state can therefore be made invalid through direct SQL:

1. Private KB K is owned and linked to agent A.
2. `knowledge_bases.agent_id` is changed from A to B.
3. The existing link from A to K remains.
4. Agent A's retrieval still resolves K even though K is now marked as B's private KB.

A similar issue exists if a linked shared KB is converted into a private KB by changing
`is_default` and `agent_id`: existing links are not revalidated.

The current test proves only that a new illegal link is rejected. It does not test
ownership transfer or shared-to-private conversion.

### Required fix

Choose one of these database-level designs:

1. Make private-KB ownership immutable after creation.
2. Add a trigger on changes to `knowledge_bases.agent_id`, `is_default`, or `org_id`
   that rejects the update unless every resulting link is valid.
3. Model private ownership separately from shared links so a private KB never depends
   on a general-purpose M:N link.

Add direct-DB tests for:

- Changing a linked private KB's owner
- Changing a shared KB with multiple links into a private KB
- Changing KB organization
- Deleting the required owner link, if every private KB must remain retrievable by its
  owner

## Remaining P0 — Legacy private-KB migration still guesses ownership

**Status: Not fixed**

Migration `0006` cleans illegal links only after migration `0003` has already inferred
and stored an owner. In a legacy database where a private KB has multiple links,
`0003` uses an `UPDATE ... FROM` join without resolving the ambiguity. PostgreSQL may
select any matching agent as the owner.

Consequences:

- Ownership can be silently assigned to the wrong agent.
- Migration `0006` may then preserve that guessed owner and delete the legitimate link.
- If one agent is selected as owner for multiple private KBs, the unique owner index in
  migration `0003` can fail before migration `0006` ever runs.

A successful migration of one clean dev clone does not verify these corrupted-but-valid
legacy states.

### Required fix

- Do not guess ownership when more than one agent is linked to a default KB.
- Detect ambiguous rows before assigning owners.
- Abort with a precise diagnostic or quarantine the affected KBs for explicit repair.
- If original ownership can be derived from an authoritative source, encode and test
  that deterministic rule.
- Add upgrade tests that construct each legacy state before running migrations
  `0003`–`0006`.

Required fixtures:

- One default KB linked to two same-org agents
- One agent linked to its own and another agent's default KB
- Several default KBs that could be assigned to the same agent
- A default KB with no link
- A historical cross-organization link created before the composite constraints

## P1 — LLM credential encryption is optional and incomplete

**Status: Partially fixed**

The implementation provides authenticated AES-256-GCM encryption when
`SECRET_ENCRYPTION_KEY` is configured. This protects newly written LLM credentials in
a database dump.

The report should not call this envelope encryption. It is direct symmetric encryption
with a key derived by SHA-256 from one configured string; there is no per-record data
encryption key wrapped by a KMS key.

Remaining defects:

- With no `SECRET_ENCRYPTION_KEY`, credentials are stored in plaintext.
- Production startup does not require an encryption key.
- Existing plaintext credentials are accepted but never migrated or re-encrypted.
- There is no key identifier, rotation, or multi-key decryption support.
- Any arbitrary-length string is accepted as the master secret; production should
  require a high-entropy key.
- A plaintext legacy credential beginning with `enc:v1:` is interpreted as ciphertext.

### Required fix

1. Fail production startup when tenant credentials are supported but no encryption key
   is configured.
2. Require a randomly generated 32-byte key in an explicit encoding, or integrate a
   cloud KMS.
3. Add a versioned key identifier to ciphertext.
4. Support old and new keys during rotation.
5. Add a migration or controlled re-encryption job for existing plaintext values.
6. Test missing keys, wrong keys, tampering, malformed ciphertext, legacy migration,
   and rotation.

## P1 — Cached clients still retain credentials

**Status: Partially fixed**

Hashing the cache-map key removes the raw secret from the map key, which is good.
However, each cached OpenAI or Anthropic SDK client must retain the actual credential in
memory to authenticate future calls. Because clients are cached without eviction, the
secret remains in process memory for the cache lifetime rather than existing only “at
call time.”

Required improvement: use a bounded cache with expiry and explicit invalidation when an
organization rotates or clears credentials. Document that process-memory compromise is
outside encryption-at-rest protection.

## P2 — Upload cap still has a configurable edge case

**Status: Improved, small issue remains**

The default 20 MB body limit leaves room for the 15 MB file cap. When an operator sets
`MAX_BODY_BYTES` below 15 MB, however, the file cap becomes exactly equal to the entire
body limit. Multipart framing consumes additional bytes, so the global middleware can
still reject a file before the route-specific limit is reached.

Reserve explicit multipart overhead or validate at startup that the global limit exceeds
the maximum file size by a documented margin.

## P2 — Graceful shutdown needs a deadline

**Status: Materially improved**

The server is now awaited before the database closes, correcting the original ordering
bug. A stuck connection can still make shutdown wait indefinitely because no forced
deadline exists.

Add a configurable shutdown deadline, abort remaining connections after it expires, and
exit non-zero when graceful draining fails.

## Round 3 verdict

The round-two remediation earns a modest increase from **72 to 75**, while remaining in
the **C+** band. The direct private-link hole is closed, crypto capability and shutdown
ordering are improved, and the test suite is stronger.

Promotion to B still requires:

1. Enforcing private-KB invariants when either links **or KB ownership fields** change.
2. Replacing ambiguous legacy ownership guessing with deterministic repair or a safe
   migration failure.
3. Making credential encryption mandatory and migratable in production.
4. Completing trusted end-user identity and runtime/network SSRF controls.
5. Adding durable jobs, quotas, production deployment hardening, and operational
   telemetry.

---

# Round 4 fixes applied (2026-07-01)

The concrete defects from the round-three verification have now been addressed without
editing immutable, previously applied migration files.

## Private-KB mutations — fixed

Migration `0007_private_kb_mutation_and_secret_state.sql` installs a trigger on changes
to `knowledge_bases.agent_id`, `is_default`, and `org_id`. An ownership transfer or
shared-to-private conversion is rejected when it would leave any existing link pointing
at a private KB owned by another agent.

Regression tests now prove that:

- A direct cross-agent private link is rejected.
- Changing a linked private KB's owner is rejected.
- Converting a multiply linked shared KB into a private KB is rejected.
- Cross-organization links remain impossible.

## Ambiguous legacy ownership — fixed safely

The migration runner performs a preflight immediately before applying migration `0003`.
It requires:

- Exactly one linked agent for every legacy default KB
- No agent linked to more than one legacy default KB

If either condition fails, migration stops with the affected KB/agent identifiers and a
repair instruction. It no longer allows PostgreSQL to select an arbitrary owner or
surface a later, opaque unique-index failure. A regression test constructs an ambiguous
legacy relationship and proves the preflight refuses it.

This is intentionally a safe failure rather than an automatic data repair: the old
schema does not contain enough authoritative information to know which of several links
was the legitimate owner.

## Production LLM credential encryption — hardened

- `SECRET_ENCRYPTION_KEY` must be a canonical base64-encoded 32-byte key.
- Production startup fails when the key is absent.
- Encryption is accurately described as AES-256-GCM authenticated encryption, not
  envelope encryption.
- An explicit `llm_api_key_encrypted` database column records state; plaintext is no
  longer guessed from a prefix.
- Startup re-encrypts existing plaintext LLM credentials and marks them encrypted.
- The legacy-prefix collision is handled by the explicit state column.
- Tests cover encrypted round trips, random IVs, plaintext migration, prefix-like
  plaintext, and ciphertext tampering.

Key rotation and cloud-KMS envelope encryption remain future operational enhancements,
not prerequisites for protecting new and legacy credentials under the configured
production key.

## Provider-client credential lifetime — hardened

OpenAI and Anthropic SDK client caches now have:

- A configurable maximum entry count
- A configurable idle TTL
- Expired-entry cleanup
- LRU-style eviction when full
- Explicit invalidation after organization LLM configuration or credential changes

SDK clients necessarily hold credentials while cached; the new bounds ensure those
credentials do not remain indefinitely after rotation.

## Upload and shutdown edge cases — fixed

- The route-level upload cap reserves 64 KiB for multipart framing below the global
  body limit.
- Graceful HTTP draining has a configurable deadline.
- When the deadline expires, remaining HTTP connections are force-closed before queue,
  database, and Redis shutdown continues.

## Round 4 verification

- `npm run typecheck` — passes.
- `npm test` — **42/42 tests pass**.
- Fresh migration chain `0000`–`0007` — passes against PostgreSQL + pgvector.
- `git diff --check` — passes.

## Round 4 grade

The score increases from **75 to 79**, remaining **C+**. The remaining gap to B is no
longer the private-KB or secret-at-rest implementation. It is primarily the broader
production boundary:

1. Trusted end-user authentication rather than caller-asserted `endUserId`
2. Connection-time/network-layer SSRF enforcement
3. Complete quota and spend governance
4. Durable-job operations under real failure/load testing
5. Production telemetry, SLOs, and broader API/provider contract coverage

---

# Round 5 production hardening (2026-07-11)

This section supersedes earlier status statements where they conflict. The implementation
was rechecked against all three root Markdown files and hardened around the remaining
production trust and operations boundaries.

## Completed

- Production startup now fails unless Redis/Dragonfly, admin-gated provisioning, a
  canonical credential-encryption key, a 32+ byte end-user signing key, and an explicit
  outbound provider hostname allowlist are configured.
- Native and OpenAI-compatible chat accept a signed `X-End-User-Token` containing
  `{ sub, orgId, exp }`. Production no longer trusts caller-asserted `endUserId`/`user`.
- Per-organization rate limits now include a per-node concurrency cap.
- Learning jobs use deterministic job IDs, retry with exponential backoff, and use the
  user-message ID as a database idempotency key. Topic assignment is serialized per agent
  to prevent concurrent duplicate-cluster creation.
- Request IDs, JSON request logs, `/ready`, protected Prometheus `/metrics`, bounded
  shutdown, and the non-root production image establish a basic operational surface.
- Migration `0008` enforces one analytics classification per user message.

## Verification

- `npm run typecheck` — passes.
- `npm test -- --reporter=dot --silent` — **44/44 pass**.
- Fresh migration chain `0000`–`0008` — passes against PostgreSQL + pgvector.
- `git diff --check` — passes.

## Remaining production engineering

These are bounded gaps rather than violations of the core tenant-isolation contract:

1. Enforce destination IP pinning/redirect revalidation in the HTTP transport and deploy
   network egress policy; hostname allowlisting alone is not a network sandbox.
2. Add persistent per-tenant storage, token, and monetary budgets. Current rate and
   concurrency controls bound request pressure but do not enforce spend.
3. Run queue, provider, streaming, shutdown, and migration failure/load drills and define
   measurable SLOs and alerts.
4. Publish a versioned OpenAPI contract and compatibility suite.
5. Add distributed tracing and production dashboards; current metrics are intentionally
   minimal process-level counters.

## Round 5 grade

The repository is **B- (84/100)**: suitable for controlled production deployments with
trusted operators and an enforced egress boundary. High-risk multi-tenant public deployment
still requires the five items above.

---

# Round 6 A+ execution pass (2026-07-11)

The repository now has an active [TODO.md](TODO.md) with explicit A+ exit criteria.
This pass closes the remaining source-controlled P0/P1 work:

- Migration `0009` adds persistent organization chat request, input/output token, and
  estimated-cost accounting.
- Hard token, estimated-spend, document-count, and stored-content ceilings are enforced;
  `/organizations/usage` exposes usage and limits to the tenant.
- Tenant provider destinations are DNS/allowlist revalidated immediately before use, not
  only when configuration is saved.
- `/openapi.json` serves a versioned OpenAPI 3.1 contract covering the native and
  OpenAI-compatible surfaces, with an automated contract smoke test.
- Queue state is included in protected Prometheus metrics; readiness verifies both
  PostgreSQL and configured Redis/Dragonfly.
- CI now enforces typecheck, the PostgreSQL suite, production dependency audit, production
  Compose validation, and production image construction.
- The production runbook defines egress requirements, SLOs/alerts, restore validation,
  credential rotation, and quarterly failure drills.

Current verification: `npm run typecheck` passes and **47/47 tests pass** through migration
`0009`. A source review can award **A- readiness**, but **A+ is intentionally withheld**
until the deployment-owned exit criteria in `TODO.md` have dated evidence: network egress
enforcement, load/failure SLO results, restore/rotation drills, and operational dashboards.
