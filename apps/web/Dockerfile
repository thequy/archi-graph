# syntax=docker/dockerfile:1
#
# Archi-Graph web (Vite + React) — build static assets, serve with nginx.
#
# Build context MUST be the MONOREPO ROOT (see infra/docker-compose.yml) because
# the web app consumes @archi-graph/shared as a workspace package.
#
# VITE_API_URL is a BUILD-TIME variable: Vite inlines `import.meta.env.*` into
# the bundle at build, so the API url must be known when `vite build` runs. It
# is passed as a build arg (default http://localhost:3001 — the browser reaches
# the api via the host-published port, not the compose-internal hostname).

# ───────────────────────── Builder ─────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /repo

ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=${VITE_API_URL}

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# shared is consumed as raw TS by Vite (no build step needed); api sources are
# not needed for the web build.
COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run -w @archi-graph/web build

# ───────────────────────── Runtime ─────────────────────────
FROM nginx:1.27-alpine AS runtime
# SPA: serve the built assets and fall back to index.html for client routes.
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
