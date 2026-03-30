# Lethe — AI Agent Instructions

## Project Overview

**Lethe** is a microservices-based data import platform. Users supply *session tokens* (never
passwords) to authenticate with third-party sites. Background workers securely fetch, stream, and
store the user's media and data directly to object storage (S3/MinIO). Multiple running Lethe
instances can interoperate: one node can import data from another via the **Peer API**.

## End Goal

Build a production-ready, self-hostable data archival service where:

1. A user pastes a session cookie from any supported site into the web UI.
2. The backend encrypts the token (AES-256-GCM) and enqueues a background job.
3. A Python worker picks up the job, scrapes the site without saving files to disk (streaming
   directly into S3/MinIO via multipart upload), and reports progress back over Server-Sent Events.
4. Any number of Lethe nodes can pull data from each other via the authenticated export API.
5. A reconciliation scanner periodically checks that every `DataItem` database record still has a
   live object in storage.

## Architecture

```
┌─────────────┐   POST /imports/start   ┌────────────────────┐
│  Next.js UI │ ──────────────────────► │  Express Backend   │
│  (frontend) │ ◄── SSE progress ──────  │  (Node.js / TS)    │
└─────────────┘                          └────────┬───────────┘
                                                  │ BullMQ job
                                         ┌────────▼───────────┐
                                         │  Python Worker     │
                                         │  (importers/)      │
                                         │  httpx → S3 stream │
                                         └────────┬───────────┘
                                                  │ webhook update
                                         ┌────────▼───────────┐
                                         │  PostgreSQL + S3   │
                                         └────────────────────┘

Peer-to-peer flow:
  Node A  POST /imports/peer  ──►  Node A worker fetches Node B's /export/items
```

## Directory Structure

```
/
├── AGENTS.md                   ← You are here
├── ansible/                    ← Ansible playbooks (primary dev/deploy workflow)
│   ├── site.yml                   full provision + deploy (all tiers)
│   ├── deploy.yml                 app-only redeploy (infrastructure assumed running)
│   ├── test.yml                   health-check playbook
│   ├── reset.yml                  dev/staging reset (Redis flush, MinIO wipe, force git pull)
│   ├── inventory/hosts.ini        target hosts — one group per deployment tier
│   ├── group_vars/all.yml         shared variables / secrets (git-ignored)
│   ├── tasks/set_service_hosts.yml  dynamic host resolution from inventory groups
│   └── roles/
│       ├── common/                  OS packages, Node.js, pm2, git clone/update (force)
│       ├── postgres/                PostgreSQL + remote-access pg_hba rules
│       ├── redis/                   Redis + requirepass authentication
│       ├── minio/                   MinIO object storage
│       ├── backend/                 Express API + Prisma migrations
│       ├── importers/               Python worker pool
│       ├── frontend/                Next.js build + pm2
│       ├── scanner/                 Reconciliation cron
│       ├── nginx/                   Caching reverse proxy (static assets + SSE-aware)
│       ├── haproxy/                 HTTP load balancer across [app] hosts
│       ├── keepalived/              VRRP virtual-IP failover for HAProxy
│       ├── node_exporter/           Prometheus node metrics (installed on all hosts)
│       ├── promtail/                Log shipping to Loki (installed on all hosts)
│       └── monitoring/              Prometheus + Loki + Grafana
├── backend/                    ← Node.js / Express / TypeScript / Prisma
│   ├── prisma/schema.prisma
│   └── src/
│       ├── controllers/           importController, internalController,
│       │                          exportController, peerController
│       ├── queues/                BullMQ producer + Redis client
│       ├── services/              SSE manager
│       └── utils/                 AES-256-GCM crypto helpers
├── importers/                  ← Python 3.11+ workers
│   ├── core/                      BaseScraper ABC, s3_streamer, crypto
│   ├── sites/                     site_a (dummy), lethe_peer (P2P importer)
│   └── main.py                    BullMQ consumer
├── scanner/                    ← Node.js reconciliation cron
│   └── scan.ts
└── frontend/                   ← Next.js 15 / Tailwind
    ├── app/
    └── components/
```

## Work Completed

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ | Infrastructure: Postgres 15, Redis 7, MinIO via Ansible roles |
| 2 | ✅ | Backend core: AES-256-GCM token encryption, BullMQ producer, `/imports/start` |
| 3 | ✅ | Python workers: `BaseScraper` ABC, `s3_streamer` (httpx → S3 multipart), dummy `SiteAScraper` |
| 4 | ✅ | Webhooks + SSE: internal job-update webhook, `/imports/:jobId/stream` SSE endpoint |
| 5 | ✅ | Frontend: Next.js 15 import form + SSE-driven progress bar |
| 6 | ✅ | Reconciliation scanner: checks every `DataItem.fileUrl` against S3/MinIO |
| 7 | ✅ | Peer API: `/export/items` + `/imports/peer` + `LetheNodeScraper` for P2P data sharing |
| 8 | ✅ | Ansible: full provision, deploy-only, health-check, and dev-reset playbooks |
| 9 | ✅ | Multi-tier inventory: separate host groups (db/cache/storage/app/lb/monitoring) |
| 10 | ✅ | Dynamic host resolution: service IPs resolved from inventory groups at play time |
| 11 | ✅ | Nginx caching reverse proxy: static-asset cache, SSE-aware, API proxy |
| 12 | ✅ | HAProxy + Keepalived: load balancing + VRRP virtual-IP failover |
| 13 | ✅ | Observability: Prometheus + Loki + Grafana + Node Exporter + Promtail |

## Key Contracts

### Public API (backend, port 3001)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/v1/imports/start` | — | Start a site import job |
| `GET`  | `/api/v1/imports/:jobId/stream` | — | SSE progress stream |
| `GET`  | `/api/v1/export/items` | `x-api-key` header | Export DataItems to peer nodes |
| `POST` | `/api/v1/imports/peer` | — | Import from another Lethe node |
| `POST` | `/api/internal/jobs/:jobId/update` | `x-internal-secret` header | Worker → backend webhook |
| `GET`  | `/healthz` | — | Health check |

### Export API response shape

```jsonc
{
  "items": [
    {
      "id": "clxxx",
      "sourceSite": "site_a",
      "dataType": "TEXT",       // TEXT | IMAGE | VIDEO | AUDIO
      "content": "…",           // for TEXT items
      "fileUrl": "imports/…",   // S3 key for media items
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ],
  "nextCursor": "clyyy"         // null when no more pages
}
```

### Peer import request body

```jsonc
{
  "peerUrl": "https://other-lethe.example.com",
  "apiKey": "<export API key of the peer>",
  "userId": "<local userId to attach imported items to>"
}
```

## Security Rules

1. **No raw passwords.** Auth relies on session cookies or OAuth tokens only.
2. **Token encryption.** Session tokens are AES-256-GCM encrypted in the backend before entering
   the Redis queue. The 32-byte `ENCRYPTION_KEY` must be set in `.env`.
3. **Internal webhook** is guarded by `x-internal-secret`; never expose it publicly.
4. **Export API** is guarded by `x-api-key` matching `EXPORT_API_KEY` env var.
5. **No secrets committed.** All `.env` files are git-ignored; only `.env.example` files exist.

## Coding Conventions

- **TypeScript strict mode** everywhere in `backend/` and `scanner/`.
- **Python type hints** on all functions/classes in `importers/`.
- Use `from __future__ import annotations` at the top of every Python file.
- New site scrapers go in `importers/sites/<name>.py` and must extend `BaseScraper`.
  Register them in `SCRAPER_REGISTRY` in `importers/main.py`.
- All new Express routes go through a dedicated controller file in `backend/src/controllers/`.
- Run `npx tsc --noEmit` in `backend/` before committing TypeScript changes.
- Run `python -m py_compile <file>` (or `python -c "import ast; ast.parse(…)"`) to check Python
  syntax before committing.
- Keep `.env.example` files up to date whenever new environment variables are added.

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | backend, scanner | PostgreSQL connection string |
| `REDIS_URL` | backend, importers | Redis connection string |
| `ENCRYPTION_KEY` | backend, importers | 32-byte key for AES-256-GCM token encryption |
| `INTERNAL_WEBHOOK_SECRET` | backend, importers | Shared secret for worker→backend webhook |
| `EXPORT_API_KEY` | backend | API key required by `/export/items` callers |
| `AWS_ACCESS_KEY_ID` | backend, importers, scanner | S3/MinIO access key |
| `AWS_SECRET_ACCESS_KEY` | backend, importers, scanner | S3/MinIO secret key |
| `AWS_ENDPOINT_URL` | backend, importers, scanner | Override endpoint (MinIO in dev) |
| `AWS_BUCKET_NAME` | backend, importers, scanner | Target S3 bucket |
| `PORT` | backend | HTTP listen port (default 3001) |
| `BACKEND_URL` | importers | Base URL of the backend (for webhooks) |

## Running Locally (Ansible)

```bash
# 1. Copy and fill in secrets
cp ansible/group_vars/all.yml.example ansible/group_vars/all.yml
# edit ansible/group_vars/all.yml

# 2. Update inventory (separate group per tier, or all same host for single-server)
# edit ansible/inventory/hosts.ini

# 3. Provision all tiers + deploy everything
ansible-playbook -i ansible/inventory/hosts.ini ansible/site.yml

# 4. Deploy only (infrastructure already running)
ansible-playbook -i ansible/inventory/hosts.ini ansible/deploy.yml

# 5. Run health checks
ansible-playbook -i ansible/inventory/hosts.ini ansible/test.yml

# 6. Reset non-DB state (dev/staging only)
ansible-playbook -i ansible/inventory/hosts.ini ansible/reset.yml
```
