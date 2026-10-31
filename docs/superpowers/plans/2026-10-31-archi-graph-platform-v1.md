# Archi-Graph Platform v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng POC single-file thành platform quản lý tài liệu kiến trúc có versioned-graph (branch/diff/merge), blast-radius, RAG hỏi–đáp local, và UI migrate từ POC.

**Architecture:** Monorepo npm workspaces: `apps/api` (NestJS) + `apps/web` (Vite+React) + `packages/shared` (DTO dùng chung) + `infra` (Docker Compose). Lõi là versioned-graph trong Postgres: entity/relation phiên bản theo commit (copy-on-write delta), fold ra head-state (materialized), branch/diff/merge three-way. Blast-radius bằng recursive CTE. RAG chạy local qua Ollama, index nền qua bảng job. Xây backend trước (Task 1–8), migrate FE sau (Task 9–11), đóng gói compose (Task 12).

**Tech Stack:** NestJS + TypeScript, Postgres 16 + pgvector, Drizzle ORM, Vitest (api) / Vitest + Testing Library (web), Vite + React + TypeScript, three.js r128, react-flow, marked + DOMPurify, Ollama (`nomic-embed-text` 768-dim + `llama3.1`), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-31-archi-graph-platform-design.md`

## Global Constraints

- Versioning bất biến: `entity_id`/`relation_id` ổn định xuyên phiên bản; commit đã tạo không bao giờ ghi đè; thay đổi = `entity_version`/`relation_version` mới với `op ∈ {add, update, delete}`.
- Branch luôn tồn tại `main`; candidate phân nhánh từ một commit của branch cha, ghi `parent_commit_id`.
- Mọi bảng versioned mang cột `author TEXT NOT NULL DEFAULT 'local'` (chừa chỗ multi-user, không hiện thực hoá v1).
- Embedding cố định **768 chiều** (`nomic-embed-text`); `doc_chunk.embedding` là `vector(768)`.
- Index RAG chạy **ngoài commit path** qua bảng `embedding_job`; commit không chặn trên embedding.
- Merge xung đột ở mức **cả entity/relation** (không field-level); thêm lớp xung đột **referential** (xoá entity còn relation trỏ tới).
- Blast-radius của candidate: thay đổi **xoá/sửa** duyệt trên head-state **baseline**; thay đổi **thêm** duyệt trên head-state **candidate**.
- Mọi câu trả lời RAG phải gắn ≥1 `entity_id` nguồn.
- v1 single-user, local-first, không auth.
- Entity type ∈ `brd|sad|hld|lld|tsd|adr|dp|dia`; group ∈ `soe|soo|soi|sos|sor|soda`; tier ∈ `t0|t1|t2|t3|t3d|t4|t5|tx`; relation kind ∈ `hierarchy|semantic`.

## Review Focus

- **Chu trình trong đồ thị** khi tính blast-radius: dữ liệu mẫu có quan hệ hai chiều tiềm năng; recursive CTE phải chặn vòng lặp vô hạn bằng tập đã thăm. → test ở Task 7.
- **Relation mồ côi** sau merge: xoá entity ở một bên trong khi bên kia còn relation trỏ tới phải thành xung đột referential, không được tạo commit có relation trỏ vào entity không tồn tại. → test ở Task 6.
- **Query RAG trên branch rỗng / tài liệu chưa index xong** (job nền chưa chạy): phải trả kết quả rỗng gọn gàng kèm thông báo, không lỗi 500. → test ở Task 8.
- **Fold với `op=delete` rồi `add` lại cùng `entity_id`**: head-state phải phản ánh version mới nhất theo thứ tự commit, không "sống lại" bản đã xoá nếu delete là mới nhất. → test ở Task 3.
- **Diff khi relation đổi endpoint** (source/target khác) vs đổi label: cả hai phải hiện là `updated`, không bị coi là không đổi. → test ở Task 5.

---

## Task 1: Monorepo scaffold + shared types

**Files:**
- Create: `package.json` (workspaces root), `tsconfig.base.json`, `.gitignore` (append), `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/index.test.ts`

**Interfaces:**
- Produces: các type/DTO dùng chung cho mọi task sau:
  - `type EntityType = 'brd'|'sad'|'hld'|'lld'|'tsd'|'adr'|'dp'|'dia'`
  - `type Group = 'soe'|'soo'|'soi'|'sos'|'sor'|'soda'`
  - `type Tier = 't0'|'t1'|'t2'|'t3'|'t3d'|'t4'|'t5'|'tx'`
  - `type RelationKind = 'hierarchy'|'semantic'`
  - `type VersionOp = 'add'|'update'|'delete'`
  - `interface LinkRef { provider: 'sharepoint'|'confluence'|'github'|'gitlab'|'drawio'|'other'; name: string; url: string }`
  - `interface EntityMetadata { author: string; date: string; status: string; tags: string[] }`
  - `interface Entity { entityId: string; type: EntityType; code: string; shortTitle: string; group: Group; tier: Tier; title: string; metadata: EntityMetadata; contentMarkdown: string; flow: unknown|null; links: LinkRef[] }`
  - `interface Relation { relationId: string; sourceEntityId: string; targetEntityId: string; kind: RelationKind; label: string }`
  - `interface HeadState { entities: Entity[]; relations: Relation[] }`
  - `interface DiffItem<T> { kind: 'added'|'updated'|'deleted'; before: T|null; after: T|null; id: string }`
  - `interface GraphDiff { entities: DiffItem<Entity>[]; relations: DiffItem<Relation>[] }`
  - `interface BlastNode { entityId: string; distance: number; via: 'baseline'|'candidate'; cause: string[] }`
  - `interface BlastRadius { direction: 'downstream'|'upstream'; nodes: BlastNode[] }`
  - `interface Citation { entityId: string; code: string; shortTitle: string }`
  - `interface RagAnswer { answer: string; citations: Citation[] }`

- [ ] **Step 1: Write the failing test** — `index.test.ts` asserts a type-guard `isEntityType(x: string): x is EntityType` returns true for `'lld'` and false for `'xxx'`, and that `ENTITY_TYPES` array has length 8.

- [ ] **Step 2: Run test to verify it fails**
Run: `npm run -w packages/shared test`
Expected: FAIL (module/symbol not found).

- [ ] **Step 3: Implement** the types above in `packages/shared/src/index.ts`, plus exported const arrays `ENTITY_TYPES`, `GROUPS`, `TIERS`, `RELATION_KINDS` and guard `isEntityType`. Configure root `package.json` with `"workspaces": ["packages/*","apps/*"]` and Vitest in `packages/shared`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npm run -w packages/shared test` — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add package.json tsconfig.base.json packages/shared
git commit -m "chore: monorepo scaffold + shared domain types"
```

---

## Task 2: API scaffold + Postgres schema + migrations

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/nest-cli.json`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/db/schema.ts` (Drizzle), `apps/api/src/db/client.ts`, `apps/api/drizzle.config.ts`, `apps/api/src/db/migrate.ts`
- Test: `apps/api/src/db/schema.test.ts`

**Interfaces:**
- Consumes: shared types (Task 1).
- Produces: Drizzle table objects exported from `schema.ts`: `branches`, `commits`, `entityVersions`, `relationVersions`, `headEntities`, `headRelations`, `docChunks`, `embeddingJobs`; a `getDb()` in `client.ts` returning a Drizzle instance bound to `DATABASE_URL`.

Schema (columns pin the design §5.2/5.3; `headEntities`/`headRelations` are the materialized head-state per branch):
- `branches(id uuid pk, name text, head_commit_id uuid null, parent_commit_id uuid null, author text default 'local', created_at timestamptz)`
- `commits(id uuid pk, branch_id uuid fk, parent_commit_id uuid null, message text, author text default 'local', created_at timestamptz)`
- `entity_versions(id uuid pk, entity_id text, commit_id uuid fk, op text, type text, code text, short_title text, "group" text, tier text, title text, metadata_json jsonb, content_markdown text, flow_json jsonb null, links_json jsonb)`
- `relation_versions(id uuid pk, relation_id text, commit_id uuid fk, op text, source_entity_id text, target_entity_id text, kind text, label text)`
- `head_entities(branch_id uuid, entity_id text, commit_id uuid, ...same payload cols as entity_versions..., pk(branch_id, entity_id))`
- `head_relations(branch_id uuid, relation_id text, commit_id uuid, source_entity_id text, target_entity_id text, kind text, label text, pk(branch_id, relation_id))`
- `doc_chunks(id uuid pk, entity_id text, commit_id uuid, chunk_index int, text text, embedding vector(768) null, pk/unique(entity_id, commit_id, chunk_index))`
- `embedding_jobs(id uuid pk, entity_id text, commit_id uuid, status text default 'pending', created_at timestamptz)`
- Migration also runs `CREATE EXTENSION IF NOT EXISTS vector;`

- [ ] **Step 1: Write the failing test** — `schema.test.ts` (Vitest + a Postgres via testcontainers OR a `DATABASE_URL` to a disposable db) runs migrations then asserts: the 8 tables exist (`information_schema.tables`), `vector` extension is installed, and `entity_versions.metadata_json` is `jsonb`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npm run -w apps/api test -- schema` — Expected: FAIL (tables absent / migrate not implemented).

- [ ] **Step 3: Implement** `schema.ts` with the Drizzle tables above, `client.ts` `getDb()`, `drizzle.config.ts`, and `migrate.ts` that applies migrations + creates the `vector` extension. Add NestJS bootstrap in `main.ts`/`app.module.ts`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npm run -w apps/api test -- schema` — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api
git commit -m "feat(api): nestjs scaffold + versioned-graph schema & migrations"
```

---

## Task 3: Commit engine + fold to head-state

**Files:**
- Create: `apps/api/src/model/commit.service.ts`, `apps/api/src/model/fold.ts`, `apps/api/src/model/model.module.ts`
- Test: `apps/api/src/model/fold.test.ts`, `apps/api/src/model/commit.service.test.ts`

**Interfaces:**
- Consumes: schema (Task 2), shared types (Task 1).
- Produces:
  - `foldHeadState(db, branchId): Promise<HeadState>` — reads head-state tables; the authoritative current view of a branch.
  - `CommitService.commit(branchId, changes: { entities: EntityChange[]; relations: RelationChange[] }, message, author?): Promise<{ commitId: string }>` where `EntityChange = { op: VersionOp; entity: Entity }` and `RelationChange = { op: VersionOp; relation: Relation }`. One transaction: insert commit row, insert the version rows, upsert/delete rows in `head_entities`/`head_relations`, advance `branches.head_commit_id`, and enqueue `embedding_jobs` for entities whose `contentMarkdown` changed (op add/update). Returns new commit id.
  - `ensureMainBranch(db): Promise<string>` — create `main` with an empty initial commit if absent; returns branch id.

- [ ] **Step 1: Write the failing tests** —
  - `commit.service.test.ts`: on a fresh `main`, commit two entities + one relation ⇒ `foldHeadState` returns exactly those 2 entities and 1 relation; `branches.head_commit_id` advanced.
  - fold-order test: commit entity E (`add`), then commit E (`delete`) ⇒ head-state has no E. Then commit E (`add`) again ⇒ head-state has E. (Review Focus: delete-then-add resurrection.)
  - commit enqueues an `embedding_jobs` row for each entity with non-empty `contentMarkdown`.

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm run -w apps/api test -- model` — Expected: FAIL.

- [ ] **Step 3: Implement** `fold.ts` + `CommitService` + `ensureMainBranch` per the Interfaces, all writes in one DB transaction.

- [ ] **Step 4: Run tests to verify they pass**
Run: `npm run -w apps/api test -- model` — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/model
git commit -m "feat(api): commit engine + fold to materialized head-state"
```

---

## Task 4: Model CRUD endpoints (entity/relation on a branch)

**Files:**
- Create: `apps/api/src/model/model.controller.ts`, `apps/api/src/model/dto.ts`
- Test: `apps/api/src/model/model.controller.test.ts` (e2e via Nest testing module + test db)

**Interfaces:**
- Consumes: `CommitService`, `foldHeadState` (Task 3).
- Produces HTTP:
  - `GET /branches/:branchId/graph` → `HeadState`
  - `POST /branches/:branchId/entities` body `Entity` (server fills `entityId` if absent) → commits an `add`/`update`, returns `{ commitId, entityId }`
  - `DELETE /branches/:branchId/entities/:entityId` → commits a `delete`
  - `POST /branches/:branchId/relations` / `DELETE .../relations/:relationId` analogous
  - Each write accepts optional `?message=`.

- [ ] **Step 1: Write the failing test** — POST an entity then GET graph returns it; DELETE it then GET graph omits it; relation endpoints likewise. Posting a relation whose source/target entity is absent in head-state ⇒ 400.

- [ ] **Step 2: Run test to verify it fails**
Run: `npm run -w apps/api test -- model.controller` — Expected: FAIL.

- [ ] **Step 3: Implement** the controller + DTO validation (class-validator) delegating to `CommitService`.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/model/model.controller.ts apps/api/src/model/dto.ts
git commit -m "feat(api): model CRUD endpoints over commits"
```

---

## Task 5: Branch + diff

**Files:**
- Create: `apps/api/src/versioning/branch.service.ts`, `apps/api/src/versioning/diff.ts`, `apps/api/src/versioning/versioning.module.ts`, `apps/api/src/versioning/versioning.controller.ts`
- Test: `apps/api/src/versioning/diff.test.ts`, `apps/api/src/versioning/branch.service.test.ts`

**Interfaces:**
- Consumes: `foldHeadState`, `CommitService` (Task 3).
- Produces:
  - `BranchService.createCandidate(name, fromBranchId): Promise<{ branchId: string }>` — new branch copying `fromBranch` head-state into its own head tables, `parent_commit_id` = fromBranch head.
  - `diffBranches(db, baseBranchId, candidateBranchId): Promise<GraphDiff>` — compare head-states by `entityId`/`relationId` → `added|updated|deleted`. A relation counts as `updated` if source/target OR label changed (Review Focus).
  - HTTP: `POST /branches` body `{ name, fromBranchId }`; `GET /branches`; `GET /diff?base=&candidate=` → `GraphDiff`.

- [ ] **Step 1: Write the failing tests** —
  - createCandidate yields a branch whose graph equals the parent's at creation; later commits on parent don't change the candidate.
  - diff: add one entity on candidate ⇒ 1 `added`; change a relation's `target` on candidate ⇒ 1 `updated` relation; delete an entity ⇒ 1 `deleted`. (Review Focus: endpoint change = updated.)

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm run -w apps/api test -- versioning` — Expected: FAIL.

- [ ] **Step 3: Implement** `BranchService` + `diffBranches` + controller.

- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/versioning
git commit -m "feat(api): candidate branches + graph diff"
```

---

## Task 6: Three-way merge (entity/relation-level + referential conflicts)

**Files:**
- Create: `apps/api/src/versioning/merge.ts`
- Modify: `apps/api/src/versioning/versioning.controller.ts` (add merge routes), `apps/api/src/versioning/branch.service.ts` (expose merge-base lookup)
- Test: `apps/api/src/versioning/merge.test.ts`

**Interfaces:**
- Consumes: `diffBranches`, `foldHeadState`, `CommitService`, merge-base (`parent_commit_id` chain).
- Produces:
  - `type MergeConflict = { kind: 'entity'|'relation'|'referential'; id: string; base: unknown|null; ours: unknown|null; theirs: unknown|null }`
  - `type MergeResult = { status: 'clean'; commitId: string } | { status: 'conflict'; conflicts: MergeConflict[] }`
  - `mergeCandidate(db, candidateBranchId, { resolutions?: Record<string, 'ours'|'theirs'> }): Promise<MergeResult>` — three-way vs common ancestor. Entity/relation changed on both sides (relative to base) and differing ⇒ `entity`/`relation` conflict. Candidate adds a relation to an entity main deleted (or vice versa) ⇒ `referential` conflict. Clean ⇒ merge commit on base branch. With `resolutions` covering all conflicts ⇒ apply chosen side and commit.
  - HTTP: `POST /branches/:candidateId/merge` body `{ resolutions? }` → `MergeResult`.

- [ ] **Step 1: Write the failing tests** —
  - non-conflicting disjoint changes on both branches ⇒ `clean`, merged head-state is the union.
  - same entity edited differently on both ⇒ one `entity` conflict; supplying `{ [id]: 'theirs' }` ⇒ `clean` with candidate's version.
  - main deletes entity X; candidate adds relation → X ⇒ one `referential` conflict; merge never produces a relation pointing at a missing entity. (Review Focus: orphan relation.)

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm run -w apps/api test -- merge` — Expected: FAIL.

- [ ] **Step 3: Implement** `mergeCandidate` + merge-base resolution + routes.

- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/versioning
git commit -m "feat(api): three-way merge with entity & referential conflicts"
```

---

## Task 7: Blast radius (recursive CTE)

**Files:**
- Create: `apps/api/src/analysis/blast.service.ts`, `apps/api/src/analysis/analysis.module.ts`, `apps/api/src/analysis/analysis.controller.ts`
- Test: `apps/api/src/analysis/blast.service.test.ts`

**Interfaces:**
- Consumes: `head_relations`/`head_entities` (Task 2/3), `diffBranches` (Task 5).
- Produces:
  - `blastRadiusForNode(db, branchId, entityId, direction: 'downstream'|'upstream', maxDepth?): Promise<BlastRadius>` — recursive CTE over `head_relations` of the branch; downstream follows edges toward dependents, upstream the reverse; records `distance`; cycle-safe via visited set; optional depth cap.
  - `blastRadiusForCandidate(db, baseBranchId, candidateBranchId, direction): Promise<BlastRadius>` — sources = diff entityIds; `delete`/`update` traversed on **baseline** head-state, `add` on **candidate** head-state; each `BlastNode.via` records which graph, `cause` records source entityIds.
  - HTTP: `GET /branches/:branchId/blast/:entityId?direction=&maxDepth=`; `GET /blast/candidate?base=&candidate=&direction=`.

- [ ] **Step 1: Write the failing tests** —
  - chain A→B→C: downstream of A = {B dist1, C dist2}; upstream of C = {B,A}.
  - cycle A→B→A terminates and returns each once. (Review Focus: cycle.)
  - candidate blast: deleting A (present in baseline) traverses baseline; adding node N with N→existing traverses candidate; `via` set accordingly.

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm run -w apps/api test -- blast` — Expected: FAIL.

- [ ] **Step 3: Implement** the two functions (raw SQL recursive CTE via Drizzle `sql`) + controller.

- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/analysis
git commit -m "feat(api): blast-radius by node and by candidate change-set"
```

---

## Task 8: RAG — LLM adapter (Ollama), background indexer, query

**Files:**
- Create: `apps/api/src/llm/llm.port.ts`, `apps/api/src/llm/ollama.adapter.ts`, `apps/api/src/rag/chunk.ts`, `apps/api/src/rag/indexer.service.ts`, `apps/api/src/rag/rag.service.ts`, `apps/api/src/rag/rag.module.ts`, `apps/api/src/rag/rag.controller.ts`
- Test: `apps/api/src/rag/chunk.test.ts`, `apps/api/src/rag/rag.service.test.ts` (LLM port mocked)

**Interfaces:**
- Consumes: `embedding_jobs`, `doc_chunks`, `head_entities` (Task 2/3).
- Produces:
  - `interface LlmPort { embed(texts: string[]): Promise<number[][]>; complete(prompt: string, context: string[]): Promise<string> }`
  - `OllamaAdapter implements LlmPort` — HTTP to `OLLAMA_URL`, `EMBED_MODEL=nomic-embed-text`, `GEN_MODEL=llama3.1`; embeddings asserted 768-dim.
  - `chunkMarkdown(text: string): { index: number; text: string }[]` — paragraph/heading-aware, default ~800 chars.
  - `IndexerService.runPending(): Promise<number>` — drains `embedding_jobs`: chunk entity's current `contentMarkdown`, embed via port, upsert `doc_chunks`, mark job done. Run as a background interval in prod; invoked directly in tests.
  - `RagService.query(branchId, question): Promise<RagAnswer>` — embed question, top-k `doc_chunks` restricted to branch head-state entityIds (pgvector cosine), build prompt, `complete`, return answer + `citations`. Empty/un-indexed branch ⇒ `{ answer: '<no indexed content>', citations: [] }`, HTTP 200. (Review Focus.)
  - HTTP: `POST /branches/:branchId/ask` body `{ question }` → `RagAnswer`.

- [ ] **Step 1: Write the failing tests** —
  - `chunk.test.ts`: a 2000-char doc with headings yields multiple chunks preserving heading boundaries.
  - `rag.service.test.ts` with a mock `LlmPort` (deterministic vectors): after `IndexerService.runPending`, querying returns an answer whose `citations` include the entity whose chunk best matches; querying a branch with no chunks returns empty citations and 200, not an error.

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm run -w apps/api test -- rag` — Expected: FAIL.

- [ ] **Step 3: Implement** port + adapter + chunker + indexer + service + controller.

- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/llm apps/api/src/rag
git commit -m "feat(api): local RAG via ollama adapter + background indexer"
```

---

## Task 9: POC data importer → main branch seed

**Files:**
- Create: `apps/api/scripts/extract-poc-data.mjs` (runs POC data script in a JSDOM/node context to emit JSON), `apps/api/src/import/poc-import.ts`, `apps/api/data/poc-seed.json` (generated, committed)
- Test: `apps/api/src/import/poc-import.test.ts`

**Interfaces:**
- Consumes: `CommitService`, `ensureMainBranch` (Task 3).
- Produces:
  - `poc-seed.json`: `{ documents: Entity[], relations: Relation[] }` derived from POC `documents`/`relations`. Mapping: `id→entityId`, keep `type/code/shortTitle/group/tier/title/contentMarkdown/flow`, `metadata→metadata`, `links→links` (default `[]`), DP entities kept as `type:'dp'`. (POC data is runtime JS behind a `doc()` factory, so the extractor must **execute** that script, not parse it statically.)
  - `importPocSeed(db): Promise<{ entities: number; relations: number }>` — ensure `main`, commit all seed entities (`add`) + relations (`add`) in one commit.

- [ ] **Step 1: Write the failing test** — `poc-import.test.ts`: run `importPocSeed` on a fresh db ⇒ head-state entity count equals `poc-seed.json` documents length and relation count matches; every relation's source/target resolves to an existing entity (no dangling).

- [ ] **Step 2: Run test to verify it fails**
Run: `npm run -w apps/api test -- poc-import` — Expected: FAIL.

- [ ] **Step 3: Implement** extractor script (generate `poc-seed.json` from `index.html`'s data script) + `importPocSeed`.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/scripts apps/api/src/import apps/api/data/poc-seed.json
git commit -m "feat(api): import POC CorpDigi dataset as main seed"
```

---

## Task 10: Web app scaffold + API client + graph render from API

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/graph/Graph3D.tsx` (port three.js r128 logic from POC), `apps/web/src/graph/layout.ts`, `apps/web/src/App.tsx`
- Test: `apps/web/src/api/client.test.ts`, `apps/web/src/graph/layout.test.ts`

**Interfaces:**
- Consumes: HTTP endpoints (Task 4/5/7/8), shared types (Task 1).
- Produces:
  - `api` client: `getGraph(branchId)`, `createEntity`, `deleteEntity`, `createRelation`, `deleteRelation`, `listBranches`, `createCandidate`, `getDiff`, `blastForNode`, `blastForCandidate`, `ask` — typed with shared DTOs.
  - `Graph3D` React component rendering `HeadState` with three.js (ported POC: group-colored nodes, type icons, hierarchy/semantic edges, 2D/3D toggle, filter, two-way selection via `selectedEntityId` prop/callback).
  - `computeLayout(head, mode)` pure function (ported from POC) — unit-testable without WebGL.

- [ ] **Step 1: Write the failing tests** — `layout.test.ts`: `computeLayout` in 2D places nodes into distinct tier columns (left→right by tier order); `client.test.ts` (fetch mocked) parses a `HeadState` response into typed entities/relations.

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm run -w apps/web test` — Expected: FAIL.

- [ ] **Step 3: Implement** scaffold, API client, `computeLayout`, and `Graph3D` (port POC three.js code to a module, data from `getGraph`).

- [ ] **Step 4: Run tests to verify they pass + build**
Run: `npm run -w apps/web test` then `npm run -w apps/web build` — Expected: PASS + clean build.

- [ ] **Step 5: Commit**
```bash
git add apps/web
git commit -m "feat(web): vite+react scaffold, api client, three.js graph from API"
```

---

## Task 11: Web — document viewer, editor, workbench (diff + blast-radius + RAG), branch switch

**Files:**
- Create: `apps/web/src/viewer/DocViewer.tsx` (marked+DOMPurify, react-flow lazy), `apps/web/src/viewer/FlowDiagram.tsx`, `apps/web/src/detail/DetailPanel.tsx`, `apps/web/src/editor/EntityEditor.tsx`, `apps/web/src/workbench/Workbench.tsx` (branch picker, diff list, blast-radius highlight, merge + conflict resolve), `apps/web/src/ask/AskPanel.tsx`
- Modify: `apps/web/src/App.tsx` (wire panels + `selectedEntityId` + `branchId` state)
- Test: `apps/web/src/viewer/DocViewer.test.tsx`, `apps/web/src/workbench/Workbench.test.tsx`

**Interfaces:**
- Consumes: `api` client + `Graph3D` (Task 10).
- Produces: wired 3-panel UI — graph ↔ viewer ↔ detail two-way sync (ported POC behavior); editor commits via API; workbench creates candidate, shows `GraphDiff`, highlights `BlastRadius` on the graph (reuse POC adjacent-edge highlight), merges with conflict resolution UI; AskPanel shows `RagAnswer` with clickable citations that select the source node.

- [ ] **Step 1: Write the failing tests** — `DocViewer.test.tsx`: renders sanitized markdown (a `<script>` in content is stripped) and shows `links` as external anchors with `rel="noopener"`. `Workbench.test.tsx` (API mocked): rendering a `GraphDiff` lists added/updated/deleted counts; clicking a citation in AskPanel fires `onSelectEntity` with the right id.

- [ ] **Step 2: Run tests to verify they fail**
Run: `npm run -w apps/web test` — Expected: FAIL.

- [ ] **Step 3: Implement** the viewer/editor/workbench/ask components and wire them in `App.tsx`.

- [ ] **Step 4: Run tests to verify they pass + build**
Run: `npm run -w apps/web test` then `npm run -w apps/web build` — Expected: PASS + clean build.

- [ ] **Step 5: Commit**
```bash
git add apps/web
git commit -m "feat(web): viewer, editor, workbench (diff/blast/merge), RAG ask panel"
```

---

## Task 12: Docker Compose + end-to-end smoke

**Files:**
- Create: `infra/docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `infra/.env.example`, `apps/api/src/health.controller.ts`, `scripts/e2e-smoke.mjs`, `README` section (append to `README.md`)
- Test: `scripts/e2e-smoke.mjs` (run against compose)

**Interfaces:**
- Consumes: all services.
- Produces: compose with services `db` (postgres+pgvector), `ollama` (pulls `nomic-embed-text` + `llama3.1`), `api`, `web`, `worker` (runs `IndexerService.runPending` loop); api runs migrations + `importPocSeed` on first boot; `GET /health` returns ok.

- [ ] **Step 1: Write the failing smoke script** — `e2e-smoke.mjs`: against the running stack — `GET /health` ok; `GET /branches/main/graph` returns the seeded CorpDigi entities (>40); create candidate → delete an entity → `GET /diff` shows 1 deleted → `GET /blast/candidate` returns affected nodes → `POST /branches/:id/merge` returns `clean`; `POST /branches/main/ask` returns an answer with ≥1 citation.

- [ ] **Step 2: Run to verify it fails (stack not up)**
Run: `node scripts/e2e-smoke.mjs` — Expected: FAIL (connection refused).

- [ ] **Step 3: Implement** Dockerfiles + compose + health + seed-on-boot + worker loop.

- [ ] **Step 4: Bring up and run smoke**
Run: `docker compose -f infra/docker-compose.yml up -d --build` then `node scripts/e2e-smoke.mjs` — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add infra apps/api/Dockerfile apps/web/Dockerfile scripts/e2e-smoke.mjs README.md
git commit -m "feat(infra): docker-compose stack + e2e smoke (seed, branch, blast, merge, ask)"
```
