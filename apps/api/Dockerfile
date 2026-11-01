# syntax=docker/dockerfile:1
#
# Archi-Graph API (NestJS) — multi-stage build.
#
# Build context MUST be the MONOREPO ROOT (see infra/docker-compose.yml:
#   build: { context: .., dockerfile: apps/api/Dockerfile }) because the api
# depends on the workspace package @archi-graph/shared and on the npm
# workspaces lockfile at the root.
#
# SHARED PACKAGE NOTE (CJS vs ESM):
#   @archi-graph/shared ships `"type":"module"` and its package.json `main`
#   points at raw TS (`src/index.ts`) for the Vite/vitest dev path. The api,
#   however, compiles to CommonJS and does `require('@archi-graph/shared')`,
#   which cannot load a .ts file nor an ESM .js from CJS. So in the builder we
#   compile shared to CommonJS (`--module commonjs`) into its dist/ and rewrite
#   its package.json to a CJS `main` with `type:commonjs`. The api's compiled
#   `require('@archi-graph/shared')` then resolves to real CommonJS JS.

# ───────────────────────── Builder ─────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /repo

# Install ALL workspace deps from the root (dev deps needed to build).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# Bring in the sources needed to build shared + api.
COPY packages/shared packages/shared
COPY apps/api apps/api

# 1. Compile @archi-graph/shared to CommonJS and make it a CJS package so the
#    api's `require(...)` resolves to loadable JS (see note above).
RUN npx tsc -p packages/shared/tsconfig.json \
      --module commonjs --moduleResolution node --outDir packages/shared/dist \
 && node -e "const fs=require('fs');const p='packages/shared/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.type='commonjs';j.main='./dist/index.js';j.types='./dist/index.d.ts';j.exports={'.':{'require':'./dist/index.js','types':'./dist/index.d.ts'}};fs.writeFileSync(p,JSON.stringify(j,null,2));"

# 2. Build the api (nest build -> apps/api/dist).
RUN npm run -w @archi-graph/api build

# 3. Prune to production dependencies for a lean runtime image.
#    NOTE: the ingest pipeline (Task 8) needs `mammoth` (.docx) and `pdf-parse`
#    (.pdf) at RUNTIME. Both are declared under "dependencies" (not devDeps) in
#    apps/api/package.json, so `--omit=dev` KEEPS them (and their pure-JS deps
#    debug + node-ensure). extract.ts imports `pdf-parse/lib/pdf-parse.js` (the
#    internal pure parser) — that file ships inside the pdf-parse package, so it
#    survives the prune too. No native binaries are involved.
RUN npm prune --omit=dev

# ───────────────────────── Runtime ─────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Copy the installed node_modules (root + workspace symlinks) and the built
# artifacts. The root node_modules holds the hoisted deps; the workspace
# symlink node_modules/@archi-graph/shared -> packages/shared resolves the
# shared package (now CommonJS).
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/packages/shared ./packages/shared
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json
# Migrations + seed data are read at runtime (resolved relative to dist).
# apps/api/data holds BOTH seeds: poc-seed.json (demo project graph, imported by
# importPocSeed) AND patterns-seed.json (global pattern catalog, seeded by
# seedPatterns). Copying the whole data dir keeps both in the runtime image.
COPY --from=builder /repo/apps/api/drizzle ./apps/api/drizzle
COPY --from=builder /repo/apps/api/data ./apps/api/data

EXPOSE 3001

# Default entry = the API server. The worker service overrides `command` to run
# the worker entry instead (see infra/docker-compose.yml).
CMD ["node", "apps/api/dist/main.js"]
