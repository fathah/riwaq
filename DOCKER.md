# Docker and deployment

Riwaq needs three services in production:

- the Riwaq API;
- PostgreSQL 16 with pgvector;
- Redis or DragonflyDB for durable jobs, shared limits, and caching.

The repository provides two Compose files:

| File | Purpose | API source |
| --- | --- | --- |
| `docker-compose.yml` | local development with source live reload | builds this checkout |
| `docker-compose.prod.yml` | production-style deployment | pulls `ghcr.io/fathah/rewaq` |

## Requirements

- a current Docker Engine or Docker Desktop release
- Docker Compose v2 (`docker compose`, not the old `docker-compose` command)
- an Anthropic or OpenAI-compatible key, either as a deployment default or configured
  later for each organization

## Run locally with Docker Compose

```bash
cp .env.example .env
```

Set `ANTHROPIC_API_KEY`, or set `OPENAI_API_KEY` and `OPENAI_BASE_URL`. Then start the
stack:

```bash
docker compose up --build
```

The services are available at:

- API: `http://localhost:3000`
- PostgreSQL from the host: `localhost:5433`
- DragonflyDB from the host: `localhost:6379`

Migrations run automatically when the API starts. Check it with:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

Stop the stack without deleting data:

```bash
docker compose down
```

To also delete the local database and Dragonfly volumes:

```bash
docker compose down --volumes
```

## Run the published production image with Compose

Create the production environment file:

```bash
cp .env.production.example .env.production
openssl rand -base64 32  # use for SECRET_ENCRYPTION_KEY
openssl rand -base64 32  # use a different value for END_USER_SIGNING_SECRET
openssl rand -hex 32     # use for ADMIN_TOKEN
```

Replace every `change-me` value in `.env.production`. Keep this file secret; it is
ignored by Git. `LLM_ALLOWED_HOSTS` must include every LLM hostname that organizations
are allowed to use.

Pull and start the stack:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
docker compose --env-file .env.production -f docker-compose.prod.yml ps
curl http://localhost:3000/ready
```

Only the API port is published. PostgreSQL and DragonflyDB remain on the private Compose
network. Their data is stored in named volumes.

View logs:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api
```

Upgrade to the newest release image:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml pull api
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

For a repeatable deployment, set `RIWAQ_IMAGE` in `.env.production` to an immutable tag,
for example `ghcr.io/fathah/rewaq:release-abc1234`, instead of `latest`.

## Run only the API image with Docker

Use this when PostgreSQL/pgvector and Redis/DragonflyDB are already managed elsewhere.
Create an environment file whose `DATABASE_URL` and `REDIS_URL` point to services that
are reachable from the container, then run:

```bash
docker pull ghcr.io/fathah/rewaq:latest
docker run -d \
  --name rewaq \
  --restart unless-stopped \
  --env-file .env.production \
  -p 3000:3000 \
  ghcr.io/fathah/rewaq:latest
```

Do not use `localhost` in `DATABASE_URL` or `REDIS_URL` unless those services run inside
the same container. Use the managed service hostname or a Docker network service name.

## Build the image locally

```bash
docker build -t rewaq:local .
```

The image runs as the non-root `riwaq` user and listens on port 3000. It runs database
migrations before accepting traffic.

## GitHub Container Registry publishing

`.github/workflows/docker-publish.yml` runs on every push to the `release` branch. It
builds Linux AMD64 and ARM64 images and publishes:

- `ghcr.io/fathah/rewaq:latest`
- `ghcr.io/fathah/rewaq:release`
- `ghcr.io/fathah/rewaq:release-<short-commit-sha>`

The workflow authenticates with GitHub's built-in `GITHUB_TOKEN`; no registry password
secret is required. The workflow grants only `contents: read` and `packages: write`.

After the first publish, open the `rewaq` package settings on GitHub and set its
visibility to **Public** if anonymous `docker pull` access is required. For a private
package, authenticate first with a classic personal access token that has `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u fathah --password-stdin
docker pull ghcr.io/fathah/rewaq:latest
```

To publish a release, merge or push the desired commit to `release`, then verify the
`Publish Docker image` workflow in the repository's Actions page.

## Useful checks

```bash
# Validate the production Compose file without starting containers.
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet

# Show running service health.
docker compose --env-file .env.production -f docker-compose.prod.yml ps

# Inspect API logs.
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 api
```
