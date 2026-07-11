# Riwaq production runbook

## Required boundaries

- Run `docker-compose.prod.yml` or an equivalent orchestrated deployment.
- Deny all API-container egress by default. Permit DNS and only the IP/CIDR ranges of
  hosts listed in `LLM_ALLOWED_HOSTS`; route traffic through an egress proxy when provider
  addresses are dynamic. The application revalidates DNS at save time and call time, but
  network policy is the final defense against rebinding and redirect bypasses.
- Keep Postgres and Redis/Dragonfly private. Terminate TLS at a trusted proxy and replace
  forwarded headers there; do not accept arbitrary client-supplied forwarding headers.

## Initial SLOs

- Availability: 99.9% successful non-4xx requests over 30 days.
- Native chat latency: p95 below 8 seconds excluding provider-declared outages.
- Queue delay: p95 below 30 seconds; no failed job older than 15 minutes.
- Recovery point objective: 15 minutes. Recovery time objective: 60 minutes.

Alert on readiness failure, HTTP 5xx ratio above 2% for 5 minutes, queue failed count
above zero for 15 minutes, queue waiting age above 30 seconds, database saturation, and
tenant usage above 80% of any configured ceiling.

## Backup and restore drill

1. Take encrypted Postgres backups at least every 15 minutes and retain daily snapshots.
2. Restore into an isolated environment with the same pgvector major version.
3. Run migrations, `npm run typecheck`, and the PostgreSQL-backed suite.
4. Verify organization counts, private-KB ownership constraints, document/chunk counts,
   encrypted secret readability, and organization usage totals.
5. Record date, backup identifier, restore duration, row-count evidence, and operator.

## Credential rotation

1. Rotate organization API keys through a controlled administrative workflow.
2. For tenant LLM keys, update `/organizations/llm`; cached clients/config are invalidated.
3. To rotate `SECRET_ENCRYPTION_KEY`, deploy a controlled re-encryption job supporting
   both old and new keys before removing the old key. Do not replace it in place.
4. Rotate `END_USER_SIGNING_SECRET` with a dual-key verification window or accept that all
   outstanding end-user tokens are immediately invalidated.
5. Record the rotation, affected key identifier, validation, and rollback result.

## Failure drills

Quarterly: restart the API during ingestion and learning, interrupt Redis, terminate a
streaming request during shutdown, restore Postgres, rotate secrets, and simulate a blocked
provider destination. Attach dated results to the release record; source code alone is not
evidence that these drills succeeded.
