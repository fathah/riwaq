# Riwaq A+ Production Checklist

This is the active, evidence-based backlog. An item is complete only when the code,
automated tests, production configuration, and operator documentation agree.

## P0 — production trust boundaries

- [x] Database-enforced organization and private-KB isolation
- [x] Hashed organization API keys and encrypted tenant LLM credentials
- [x] Signed, expiring, organization-bound end-user identity
- [x] Production-required outbound hostname allowlist
- [x] Revalidate tenant-controlled destinations at request time
- [x] Document redirect/DNS/egress deployment requirements
- [x] Persistent per-organization token, storage, and estimated-spend governance

## P1 — contract and reliability

- [x] Redis/Dragonfly-backed durable ingestion and learning queues
- [x] Retry/idempotency protection for ingestion and learning
- [x] Bounded graceful shutdown and readiness checks
- [x] Versioned OpenAPI 3.1 contract served by the API
- [x] Contract smoke test covering native and OpenAI-compatible paths
- [x] Queue dependency health in readiness and operational metrics
- [x] Fresh migration-chain coverage through the newest schema

## P2 — production assurance

- [x] Request IDs, structured request logs, and protected process metrics
- [x] Non-root, production-only container and private DB/cache networking
- [ ] Provider and streaming compatibility matrix
- [ ] Load, restart, retry, and forced-shutdown test evidence
- [ ] Traces, dashboards, alert rules, and measurable SLOs
- [x] Backup/restore and credential-rotation runbooks
- [x] CI release gate: typecheck, tests, audit, Compose validation, image build
- [x] Protected Next.js management console with first-run environment setup

## A+ exit criteria

- [ ] No open P0 or P1 item
- [ ] All release-gate commands pass from a clean checkout
- [ ] Production deployment has enforced network egress policy
- [ ] Load/failure results meet documented SLOs
- [ ] Restore and key-rotation drills have dated evidence
