# Archi-Graph

> POC: a Knowledge Graph for architecture documentation, contained in a single `.html` file.

Archi-Graph is a proof-of-concept for managing architecture documentation (BRD, SAD, HLD, LLD, TSD, ADR, design patterns, diagrams) as a **Knowledge Graph** that visualizes the relationships between documents. It runs directly in the browser with no build tooling.

## Features

- **3-panel layout** with two-way sync: `3D graph (three.js)` | `document viewer` | `detail panel`.
- **three.js** — a 3D graph of document relationships, used for navigation.
- **react-flow** — detailed flow diagrams inside a document (service flow, data flow), lazy-mounted.
- Viewer renders **Markdown and HTML**.
- **Embedded sample data** inside the file — no backend required.
- Two edge kinds:
  - **Hierarchy** — structural chain BRD → SAD → HLD → LLD → TSD.
  - **Semantic** — meaning-based relationships between documents.

The sample dataset models the **CorpDigi (Corporate Digital Banking)** platform along the flow: Frontend → API Gateway → BFF → Backend Services → Inbound Gateway → System of Record.

## Usage

Open `index.html` directly in a browser. All libraries are loaded from CDN (UMD builds), so no bundler or server is required.

## Documentation

- [`SPEC.md`](SPEC.md) — specification and implementation plan (Vietnamese).
- [`SPEC.en.md`](SPEC.en.md) — specification and implementation plan (English).

## Tech Stack

- [three.js](https://threejs.org/) r128 (3D graph)
- [react-flow](https://reactflow.dev/) (flow diagrams)
- [marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify) (safe Markdown rendering)

## Running the full stack (Docker/Podman Compose)

The platform ships a single compose file, `infra/docker-compose.yml`, with five
services: `db` (Postgres + pgvector), `ollama` (local LLM — self-pulls the
embedding + generation models), `api` (NestJS), `worker` (background embedder),
and `web` (the Vite SPA). The compose file is standard compose spec and runs on
either Docker or Podman.

> This repository is developed against **Podman 5.x inside WSL** (no Docker
> daemon). All commands below use `podman compose` through WSL. On a Docker host,
> substitute `docker compose` for `podman compose`.

### 1. Configure

```bash
cp infra/.env.example infra/.env   # optional — every value has a default
```

### 2. Bring the stack up

```bash
# From the repo root, via WSL:
wsl -e bash -lc "cd \"$PWD\" && podman compose -f infra/docker-compose.yml up -d --build"
# Or from inside a WSL shell already in the repo:
podman compose -f infra/docker-compose.yml up -d --build
```

Startup ordering is enforced by healthchecks:

- `db` becomes healthy once `pg_isready` passes.
- `ollama` becomes healthy only once **both** `nomic-embed-text` and `llama3.1`
  are present (its entrypoint pulls them on first boot — see below).
- `api` waits for `db` **and** `ollama` to be healthy, then (as the **single
  migrator**) applies migrations and seeds the POC dataset once, and serves
  `GET /health`.
- `worker` waits for the schema the `api` created, then loops the indexer.
- `web` waits for `api` to be healthy.

### Ollama models

The `ollama` service self-provisions its models via
`infra/ollama-entrypoint.sh`: it starts `ollama serve`, waits for the API, then
`ollama pull nomic-embed-text` (768-dim embeddings) and `ollama pull llama3.1`
(generation). This is idempotent and persists across restarts via the
`ollama-data` volume.

`llama3.1` is ~4.9 GB, so the **first** boot blocks on that download; the
`ollama` healthcheck has a long retry budget to accommodate it. If you prefer to
pull the models once by hand (e.g. to pre-warm the volume), run:

```bash
wsl -e bash -lc "podman exec infra_ollama_1 ollama pull nomic-embed-text"
wsl -e bash -lc "podman exec infra_ollama_1 ollama pull llama3.1"
```

### 3. Run the end-to-end smoke

With the stack healthy:

```bash
node scripts/e2e-smoke.mjs
```

It exercises the whole platform through the live API:

1. `GET /health` → ok.
2. Resolve `main`'s id, then `GET /branches/<main>/graph` → seeded CorpDigi
   entities (>40).
3. Create a candidate branch → delete an entity on it → `GET /diff` shows
   exactly 1 deleted entity → `GET /blast/candidate` returns affected nodes →
   `POST /branches/<candidate>/merge` returns `clean`.
4. `POST /branches/<main>/ask` → an answer with ≥1 citation. This step **polls**
   (up to `ASK_POLL_TIMEOUT_MS`, default 240s) because the `worker` must embed
   the seeded docs before the RAG retrieval can cite anything.

Smoke config via env: `API_URL` (default `http://localhost:3001`),
`ASK_POLL_TIMEOUT_MS`, `ASK_POLL_INTERVAL_MS`.

### The single-migrator / seed-guard design

`runMigrations()` issues `CREATE EXTENSION IF NOT EXISTS vector`, which is **not**
safe under concurrency — two callers can race on `pg_extension`. Two protections
address this:

- **Only the `api` migrates.** The `worker` sets `BOOTSTRAP_DB=0` and calls
  `waitForSchema()` (polls for the `embedding_jobs` table) before its loop; it
  never issues DDL.
- **Advisory lock.** `runMigrations()` wraps the extension creation + migrations
  in a Postgres session advisory lock, so even concurrent migrators serialize
  rather than race.

The POC seed is guarded against double-seeding on restart: the api seeds only
when `main`'s head-state is empty, so a container restart (or a second replica)
detects the existing seed and skips it.

### Tear down

```bash
podman compose -f infra/docker-compose.yml down        # keep volumes
podman compose -f infra/docker-compose.yml down -v     # also drop db + model volumes
```
