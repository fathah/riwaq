# Docker and deployment

Riwaq's API needs three services in production, plus the optional web console:

- the Riwaq API;
- PostgreSQL 16 with pgvector;
- Redis or DragonflyDB for durable jobs, shared limits, and caching.
- the Next.js management console.

The repository provides two Compose files:

| File | Purpose | Application source |
| --- | --- | --- |
| `docker-compose.yml` | local development with source live reload | builds this checkout |
| `docker-compose.prod.yml` | production-style deployment | pulls the API and web images from GHCR |

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
- dashboard: `http://localhost:3001`
- PostgreSQL from the host: `localhost:5433`
- DragonflyDB from the host: `localhost:6379`

Migrations run automatically when the API starts. Check it with:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

The dashboard starts in setup mode until `RIWAQ_API_KEY` and
`RIWAQ_DASHBOARD_TOKEN` are set in `.env`. Follow the instructions at
`http://localhost:3001`, then recreate only the web service:

```bash
docker compose up -d --force-recreate web
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
openssl rand -hex 32     # use a different value for RIWAQ_DASHBOARD_TOKEN
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

The API and dashboard ports are published. PostgreSQL and DragonflyDB remain on the
private Compose network. Their data is stored in named volumes. The dashboard keeps
`RIWAQ_API_KEY` on its server and protects the UI with `RIWAQ_DASHBOARD_TOKEN`.

On the first boot, visit `http://localhost:3001`. If there is no organization API key
yet, create an organization as shown on the setup page, add the returned one-time key
to `.env.production`, and recreate the web container:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --force-recreate web
```

View logs:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api web
```

Upgrade to the newest release image:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml pull api web
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

For a repeatable deployment, set both `RIWAQ_IMAGE` and `RIWAQ_WEB_IMAGE` in
`.env.production` to matching immutable `release-<sha>` tags instead of `latest`.

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
docker build -t rewaq-web:local ./web
```

Both images run as non-root users. The API listens on port 3000 and runs database
migrations before accepting traffic; the dashboard listens on port 3001.

## GitHub Container Registry publishing

`.github/workflows/docker-publish.yml` runs on every push to the `release` branch. It
builds Linux AMD64 and ARM64 API and dashboard images. Each image receives `latest`,
`release`, and `release-<short-commit-sha>` tags:

- `ghcr.io/fathah/rewaq:latest`
- `ghcr.io/fathah/rewaq:release`
- `ghcr.io/fathah/rewaq:release-<short-commit-sha>`
- `ghcr.io/fathah/rewaq-web:latest`
- `ghcr.io/fathah/rewaq-web:release`
- `ghcr.io/fathah/rewaq-web:release-<short-commit-sha>`

The workflow authenticates with GitHub's built-in `GITHUB_TOKEN`; no registry password
secret is required. The workflow grants only `contents: read` and `packages: write`.

After the first publish, open both package settings on GitHub and set their visibility
to **Public** if anonymous `docker pull` access is required. For private packages,
authenticate first with a classic personal access token that has `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u fathah --password-stdin
docker pull ghcr.io/fathah/rewaq:latest
docker pull ghcr.io/fathah/rewaq-web:latest
```

To publish a release, merge or push the desired commit to `release`, then verify the
`Publish Docker images` workflow in the repository's Actions page.

## Useful checks

```bash
# Validate the production Compose file without starting containers.
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet

# Show running service health.
docker compose --env-file .env.production -f docker-compose.prod.yml ps

# Inspect application logs.
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 api web
```
