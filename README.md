# Disclaimer

Status: Archived / Proof of Concept
This repository is a technical demonstration of microservices-based data portability. It is provided for educational and research purposes only. The author does not maintain this software and is not responsible for its use. Users are responsible for ensuring their use of this tool complies with the Terms of Service of any third-party providers.

# Lethe

Lethe is an open-source, self-hostable framework for **personal data sovereignty and archival**.
It enables users to exercise their right to data portability by interfacing with remote services
using their own **user-authorized session credentials** (never passwords). Designed as a
transparent "user agent," Lethe's microservices architecture allows individuals to securely migrate
their own digital history directly to private object storage (S3/MinIO). Lethe facilitates
interoperability through a Peer API, allowing users to manage their data across independent nodes
they control.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start (Ansible — recommended)](#quick-start-ansible--recommended)
- [Local Development (Docker Compose)](#local-development-docker-compose)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Adding a New Site Importer](#adding-a-new-site-importer)
- [Responsible Use](#responsible-use)
- [Security](#security)

---

## Features

- **User-authorized access** — session cookies / OAuth tokens only; **no plaintext passwords stored**.
- **AES-256-GCM encryption** — session tokens are encrypted before entering the job queue.
- **Streaming personal archival** — Python workers pipe data from remote services directly into
  S3/MinIO via multipart upload; nothing is written to disk.
- **Real-time progress** — Server-Sent Events (SSE) stream live job status to the browser.
- **Peer-to-peer sync** — any Lethe node can pull archived data from another via the export API.
- **Reconciliation scanner** — a periodic cron job verifies that every database record has a
  corresponding live object in storage.
- **Ansible-managed deployment** — a single playbook provisions and deploys the full stack to any
  Linux server.

---

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

| Component | Technology |
|-----------|-----------|
| Frontend | Next.js 15, Tailwind CSS |
| Backend API | Node.js, Express, TypeScript |
| Job queue | BullMQ + Redis 7 |
| Database | PostgreSQL 15, Prisma ORM |
| Object storage | MinIO (S3-compatible) |
| Workers | Python 3.11+, httpx |
| Process manager | pm2 |
| Deployment | Ansible |

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Ansible | ≥ 2.14 |
| A target Linux server | Ubuntu 22.04+ recommended |
| SSH access to the target server | — |

The Ansible playbooks install every other dependency (Node.js, Python, pm2, PostgreSQL, Redis,
MinIO) on the target host automatically.

---

## Quick Start (Ansible — recommended)

### 1 — Copy and fill in secrets

```bash
cp ansible/group_vars/all.yml.example ansible/group_vars/all.yml
```

Open `ansible/group_vars/all.yml` and fill in every `CHANGE_ME` value.  Key fields:

| Variable | Description |
|----------|-------------|
| `lethe_host` | Public-facing IP or hostname of the server (used by browser clients) |
| `postgres_password` | PostgreSQL password |
| `minio_access_key` / `minio_secret_key` | MinIO credentials |
| `encryption_key` | Exactly 32 UTF-8 bytes — used for AES-256-GCM token encryption |
| `internal_webhook_secret` | Shared secret between workers and the backend webhook |
| `export_api_key` | API key required by callers of `/api/v1/export/items` |
| `git_repo_url` | SSH or HTTPS URL of this repository |

> **`all.yml` is git-ignored and must never be committed.**

### 2 — Update the inventory

Edit `ansible/inventory/hosts.ini` and replace the placeholder with your server:

```ini
[lethe]
your.server.ip ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/id_rsa
```

### 3 — Provision and deploy

```bash
# Full provision (installs all services) + deploy
ansible-playbook -i ansible/inventory/hosts.ini ansible/site.yml

# Re-deploy application code only (services already running)
ansible-playbook -i ansible/inventory/hosts.ini ansible/deploy.yml

# Run health checks
ansible-playbook -i ansible/inventory/hosts.ini ansible/test.yml
```

After a successful run the following are accessible (replace `<lethe_host>` with the value you set
in `all.yml`):

| Service | URL |
|---------|-----|
| Frontend | `http://<lethe_host>:3000` |
| Backend API | `http://<lethe_host>:3001` |
| MinIO console | `http://<lethe_host>:9001` |

---

## Local Development (Docker Compose)

Docker Compose spins up only the infrastructure services (PostgreSQL, Redis, MinIO). You then run
the backend, frontend, and worker processes locally.

### 1 — Start infrastructure

```bash
docker compose up -d
```

### 2 — Backend

```bash
cd backend
cp .env.example .env   # edit .env if needed
npm install
npx prisma migrate dev
npx tsc --watch &
node dist/index.js
```

### 3 — Python worker

```bash
cd importers
cp .env.example .env   # edit .env if needed
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

### 4 — Frontend

```bash
cd frontend
cp .env.example .env.local   # or create manually
npm install
npm run dev
```

---

## Environment Variables

Variables are grouped by service.  The Ansible templates generate these files automatically from
`ansible/group_vars/all.yml`; the `.env.example` files in each directory document the same
variables for local development.

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `ENCRYPTION_KEY` | 32-byte AES-256-GCM key |
| `INTERNAL_WEBHOOK_SECRET` | Shared secret for worker→backend webhook |
| `EXPORT_API_KEY` | API key required by `/api/v1/export/items` |
| `AWS_ACCESS_KEY_ID` | S3/MinIO access key |
| `AWS_SECRET_ACCESS_KEY` | S3/MinIO secret key |
| `AWS_ENDPOINT_URL` | S3 endpoint (set to MinIO URL in dev) |
| `AWS_BUCKET_NAME` | Target S3 bucket name |
| `PORT` | HTTP listen port (default `3001`) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | Directory for log files |

### Python worker (`importers/.env`)

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection string |
| `BACKEND_URL` | Base URL of the backend (for webhooks) |
| `INTERNAL_WEBHOOK_SECRET` | Shared secret for webhook calls |
| `ENCRYPTION_KEY` | Same 32-byte key as the backend |
| `AWS_ACCESS_KEY_ID` | S3/MinIO access key |
| `AWS_SECRET_ACCESS_KEY` | S3/MinIO secret key |
| `AWS_ENDPOINT_URL` | S3 endpoint |
| `AWS_BUCKET_NAME` | Target S3 bucket name |
| `LOG_LEVEL` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `LOG_DIR` | Directory for log files |

### Scanner (`scanner/.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `AWS_ACCESS_KEY_ID` | S3/MinIO access key |
| `AWS_SECRET_ACCESS_KEY` | S3/MinIO secret key |
| `AWS_ENDPOINT_URL` | S3 endpoint |
| `AWS_BUCKET_NAME` | Target S3 bucket name |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | Directory for log files |

### Frontend (`frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_BACKEND_URL` | Backend base URL — must be reachable from the browser |

---

## API Reference

### Public endpoints (port 3001)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/imports/start` | — | Start a site import job |
| `GET` | `/api/v1/imports/:jobId/stream` | — | SSE progress stream for a job |
| `POST` | `/api/v1/imports/peer` | — | Import from another Lethe node |
| `GET` | `/api/v1/export/items` | `x-api-key` header | Export `DataItem`s to peer nodes |
| `GET` | `/api/v1/items` | — | List archived items |
| `GET` | `/api/v1/files/presign` | — | Generate a presigned S3 download URL |
| `GET` | `/api/v1/creators` | — | List creators |
| `GET` | `/api/v1/creators/:creatorId/posts` | — | List posts for a creator |
| `GET` | `/api/v1/posts/:postId` | — | Get a single post |
| `GET` | `/healthz` | — | Health check — returns `{ "status": "ok" }` |

### Internal endpoint (not exposed publicly)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/internal/jobs/:jobId/update` | `x-internal-secret` header | Worker → backend job-status webhook |

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

---

## Project Structure

```
/
├── AGENTS.md                   ← AI agent instructions
├── README.md                   ← This file
├── docker-compose.yml          ← Infrastructure services for local dev
├── ansible/                    ← Ansible playbooks (primary deploy workflow)
│   ├── site.yml                   full provision + deploy
│   ├── deploy.yml                 app-only redeploy (services assumed running)
│   ├── test.yml                   health-check playbook
│   ├── inventory/hosts.ini        target hosts
│   ├── group_vars/all.yml         shared variables / secrets (git-ignored)
│   └── roles/                     per-service roles
├── backend/                    ← Node.js / Express / TypeScript / Prisma
│   ├── prisma/schema.prisma
│   └── src/
│       ├── controllers/
│       ├── queues/
│       ├── services/
│       └── utils/
├── importers/                  ← Python 3.11+ workers
│   ├── core/                      BaseScraper ABC, s3_streamer, crypto
│   ├── sites/                     per-site scrapers
│   └── main.py                    BullMQ consumer
├── scanner/                    ← Node.js reconciliation cron
│   └── scan.ts
└── frontend/                   ← Next.js 15 / Tailwind
    ├── app/
    └── components/
```

---

## Adding a New Site Importer

1. Create `importers/sites/<name>.py` and subclass `BaseScraper`:

   ```python
   from __future__ import annotations
   from core.base_scraper import BaseScraper

   class MySiteScraper(BaseScraper):
       async def run(self) -> None:
           # fetch and stream content using self.stream_url_to_s3(...)
           ...
   ```

2. Register the scraper in `SCRAPER_REGISTRY` inside `importers/main.py`:

   ```python
   from sites.my_site import MySiteScraper

   SCRAPER_REGISTRY: dict[str, type[BaseScraper]] = {
       "site_a": SiteAScraper,
       "my_site": MySiteScraper,   # ← add this
   }
   ```

3. Restart the worker process (or re-run the Ansible deploy playbook).

---

## Responsible Use

Lethe is a personal data-portability tool. It is designed exclusively to help **you** archive
**your own** data from services **you have authorized access to**.

- **Do not** use Lethe to access data belonging to other users.
- **Do not** use Lethe to bypass paywalls, access controls, or rate limits in a manner that
  violates a service's terms of use.
- **Do not** use Lethe to collect, store, or redistribute copyrighted material without the
  necessary rights.
- The developers of Lethe are not responsible for how end users deploy or operate the software.
  Users assume full legal responsibility for their own use.

Lethe's design aligns with the principles of GDPR Article 20 (right to data portability) and the
EU Data Act. Using Lethe to exercise your own data-portability rights is consistent with those
frameworks; using it to access or aggregate third-party data is not.

---

## Security

No guarantees. This is Proof of Concept project coded by AI. Absolutely zero security guarantees. 