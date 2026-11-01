# Archi-Graph Projects Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mở rộng Archi-Graph v1 thành site đa-project: trang chủ Projects, upload tài liệu (trích+tóm tắt LLM), soạn sơ đồ Mermaid (System/Sequence), và Pattern Wiki liên kết vào graph.

**Architecture:** 4 vertical slice trên nền v1 (NestJS/Drizzle/Postgres+pgvector + Vite/React + Ollama). Slice A thêm `projects` + `project_id` trên branches + scope RAG tables (nền). Slice B thêm Mermaid diagram là field versioned. Slice C thêm upload + ingest nền (trích+tóm tắt→commit entity). Slice D thêm pattern catalog toàn cục + `appliesPatterns` + wiki. Giữ nguyên lõi commit/head-state/diff/merge/blast; chỉ thêm chiều project và field entity mới.

**Tech Stack:** NestJS + Drizzle, Postgres 16 + pgvector, Vitest, Vite + React + TS + react-router, mermaid + DOMPurify, reactflow (giữ), Ollama (nomic-embed-text + llama3.1), mammoth (.docx) + pdf-parse (.pdf), Podman Compose.

**Spec:** `docs/superpowers/specs/2026-11-01-archi-graph-projects-extension-design.md`

## Global Constraints

- Cô lập project tuyệt đối: mọi read graph/RAG lọc theo project; không truy vấn nào trả dữ liệu cross-project **trừ** Pattern "used-by" (cố ý quét main nhiều project).
- `branches.project_id uuid NOT NULL` FK → `projects.id`; migration backfill branch cũ về một project demo "CorpDigi" trước khi SET NOT NULL.
- `doc_chunks` và `embedding_jobs` thêm `project_id uuid`; RAG query **phải** lọc `doc_chunks.project_id = :projectId` (entity_id trùng được giữa project → JOIN theo entity_id là lỗ rò).
- Lõi versioned-graph (commit immutable, head-state materialized, diff/merge/blast) **không đổi hành vi**; chỉ thêm project_id vào branch và field mới vào entity.
- `diagrams` + `appliesPatterns` là field VERSIONED hạng nhất của entity (qua entity_versions + head_entities + fold + commit + equality.entityEquals), KHÔNG phải bảng phụ.
- Upload/tóm tắt chạy NỀN (không trong request handler); ingest job dùng lại `CommitService.commit` để ghi entity lên branch main của project.
- Mermaid render: `securityLevel:'strict'` + DOMPurify sanitize SVG trước khi vào DOM. Markdown vẫn marked+DOMPurify. File links http(s)-only.
- react-flow cũ vẫn render (không regress 5 pattern + landscape). Không regress 109 test v1.
- 1 user, local-first, không auth. Blob trên filesystem volume. entity type ∈ brd|sad|hld|lld|tsd|adr|dp|dia; group ∈ soe|soo|soi|sos|sor|soda; tier ∈ t0|t1|t2|t3|t3d|t4|t5|tx.
- diagram kind ∈ system|sequence. "Used by" chỉ quét branch `main` mỗi project.

## Review Focus

- **Entity id trùng giữa 2 project** làm RAG trả lẫn chunk: query phải lọc project_id, không chỉ entity_id → test cô lập ở Task 3.
- **Migration SET NOT NULL khi còn branch chưa backfill** sẽ vỡ: phải tạo project demo + UPDATE trước → test migration trên DB có branch cũ ở Task 1.
- **Diagram/appliesPatterns không được thread qua fold/merge** → entity mất field sau commit/merge: test round-trip commit→fold giữ nguyên field ở Task 5 & Task 10.
- **File upload sai mime / parse hỏng / file rỗng**: ingest phải đánh dấu lỗi gọn (status 'failed'), không treo job mãi → test ở Task 8.
- **Mermaid chứa payload XSS** (vd `<script>` qua label): render phải sanitize → test ở Task 6.

---

# SLICE A — Projects nền (Task 1–4)

## Task 1: Schema projects + project_id + migration backfill

**Files:**
- Modify: `apps/api/src/db/schema.ts` (thêm bảng `projects`; cột `project_id` trên `branches`, `docChunks`, `embeddingJobs`)
- Create: `apps/api/drizzle/` migration (generate) + `apps/api/src/db/migrate-projects.ts` nếu cần custom backfill
- Test: `apps/api/src/db/projects-schema.test.ts`

**Interfaces:**
- Consumes: schema v1 (branches, docChunks, embeddingJobs).
- Produces: Drizzle table `projects(id uuid pk, name text, description text, created_at timestamptz)`; `branches.projectId`, `docChunks.projectId`, `embeddingJobs.projectId` (uuid). Migration tạo project demo "CorpDigi" (id ổn định hoặc đọc lại), backfill mọi `branches.project_id` + mọi `doc_chunks`/`embedding_jobs` hiện có về project đó, rồi `branches.project_id` SET NOT NULL + FK.

- [ ] **Step 1: Write the failing test** — trên DB đã có schema v1 + một branch `main` seed sẵn (chèn thủ công trong test): chạy migration mới ⇒ bảng `projects` tồn tại; có đúng 1 project tên 'CorpDigi'; branch `main` cũ có `project_id` = project đó (không null); cột `project_id` tồn tại trên `doc_chunks` và `embedding_jobs`.
- [ ] **Step 2: Run test** — `npm run -w apps/api test -- projects-schema` — Expected: FAIL.
- [ ] **Step 3: Implement** bảng + cột + migration backfill (nullable → tạo project demo → UPDATE branches/doc_chunks/embedding_jobs → SET NOT NULL + FK trên branches). Thứ tự an toàn để không vỡ NOT NULL.
- [ ] **Step 4: Run test** — PASS.
- [ ] **Step 5: Commit** — `feat(api): projects table + project_id scoping + backfill migration`.

## Task 2: Projects module (CRUD + ensureProjectMain)

**Files:**
- Create: `apps/api/src/projects/project.service.ts`, `projects.module.ts`, `projects.controller.ts`, `dto.ts`
- Modify: `apps/api/src/model/commit.service.ts` (thêm `ensureProjectMain(db, projectId)`; giữ `ensureMainBranch` làm wrapper nếu còn dùng), `apps/api/src/app.module.ts` (import ProjectsModule)
- Test: `apps/api/src/projects/project.service.test.ts`, `projects.controller.test.ts`

**Interfaces:**
- Consumes: DB_TOKEN (global), CommitService engine.
- Produces:
  - `ProjectService.create(name, description?)`, `list()`, `get(id)`, `rename(id,name)`, `remove(id)` (xoá project + branch/dữ liệu của nó — hoặc chặn nếu có dữ liệu; builder chọn, mặc định xoá cascade dữ liệu project).
  - `ensureProjectMain(db, projectId): Promise<string>` (branchId) — tìm branch `name='main' AND project_id=projectId`, tạo nếu thiếu (commit rỗng ban đầu như `ensureMainBranch`).
  - HTTP: `POST /projects {name,description?}`, `GET /projects`, `GET /projects/:id`, `PATCH /projects/:id {name}`, `DELETE /projects/:id`.

- [ ] **Step 1: Write failing tests** — create project ⇒ list có nó + tự có branch main (ensureProjectMain idempotent: gọi 2 lần trả cùng branchId); 2 project có 2 branch main khác nhau (project_id khác).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** service + `ensureProjectMain` + controller + DI provider-factory (theo mẫu ModelModule).
- [ ] **Step 4: Run** — PASS + `npm run -w apps/api build`.
- [ ] **Step 5: Commit** — `feat(api): projects CRUD + ensureProjectMain`.

## Task 3: Project-scope branches, diff, RAG isolation

**Files:**
- Modify: `apps/api/src/versioning/branch.service.ts` (`listBranches(projectId)`), `versioning.controller.ts` (GET /branches lọc project), `apps/api/src/model/commit.service.ts` (enqueue embedding_jobs kèm project_id của branch), `apps/api/src/rag/rag.service.ts` (query lọc project_id), `apps/api/src/rag/indexer.service.ts` (ghi doc_chunks kèm project_id)
- Test: `apps/api/src/rag/rag-isolation.test.ts`, `apps/api/src/versioning/branch-scope.test.ts`

**Interfaces:**
- Consumes: Task 1 cột project_id; Task 2 ensureProjectMain.
- Produces:
  - `BranchService.listBranches(projectId)` — chỉ branch của project.
  - `RagService.query(branchId, question, topK?)` **thêm lọc** `doc_chunks.project_id` = project_id của branch (lookup project_id từ branch). JOIN head_entities giữ nguyên nhưng điều kiện project_id là ranh giới cô lập.
  - CommitService khi enqueue embedding_jobs ghi `project_id` = project_id của branch; IndexerService khi upsert doc_chunks ghi `project_id` tương ứng.

- [ ] **Step 1: Write failing tests (Review Focus)** —
  - Isolation: tạo 2 project, mỗi project commit một entity **cùng entityId** `foo` nội dung khác nhau, index cả hai (IndexerService + LLM mock); `RagService.query` trên branch main project A chỉ trả citation/chunk của A, không của B.
  - `listBranches(projectIdA)` không trả branch của project B.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** lọc project_id ở query RAG + listBranches + ghi project_id khi enqueue/upsert.
- [ ] **Step 4: Run** — PASS + full api suite không regress.
- [ ] **Step 5: Commit** — `feat(api): project-scoped branches + RAG isolation`.

## Task 4: FE router + Projects home + project-scoped App boot

**Files:**
- Modify: `apps/web/package.json` (thêm react-router-dom), `apps/web/src/main.tsx` (router), `apps/web/src/App.tsx` (nhận projectId, resolve main theo project)
- Create: `apps/web/src/routes/ProjectsHome.tsx`, `apps/web/src/api/client.ts` (thêm projects fns)
- Test: `apps/web/src/routes/ProjectsHome.test.tsx`, `apps/web/src/App.test.tsx` (sửa: resolve main theo projectId)

**Interfaces:**
- Consumes: HTTP /projects + /branches (project-scoped).
- Produces:
  - api client: `listProjects()`, `createProject(name,description?)`, `getProject(id)`, `renameProject(id,name)`, `deleteProject(id)`.
  - Routes: `/` → ProjectsHome (list + tạo); `/projects/:projectId` → App cũ bọc lại, resolve branch main của project đó (listBranches(projectId) → name==='main') trước khi getGraph.
  - App nhận `projectId` (prop/route param); branch resolution + listBranches theo project.

- [ ] **Step 1: Write failing tests** — ProjectsHome: mock listProjects trả 2 project ⇒ render 2 item; tạo project gọi createProject rồi điều hướng. App.test: với projectId='p1', resolve main của p1 (listBranches('p1')) rồi getGraph với UUID đó, không gọi 'main' literal.
- [ ] **Step 2: Run** — `npm run -w apps/web test` — FAIL.
- [ ] **Step 3: Implement** router + ProjectsHome + client + App project-aware.
- [ ] **Step 4: Run** — PASS + `npm run -w apps/web build`.
- [ ] **Step 5: Commit** — `feat(web): router + projects home + project-scoped graph`.

---

# SLICE B — Mermaid diagram (Task 5–6)

## Task 5: Entity.diagrams versioned field (shared + engine)

**Files:**
- Modify: `packages/shared/src/index.ts` (Entity thêm `diagrams?`), `apps/api/src/db/schema.ts` (cột `diagrams_json` trên entity_versions + head_entities), migration, `apps/api/src/model/commit.service.ts` (map diagramsJson), `apps/api/src/model/fold.ts` (đọc diagramsJson), `apps/api/src/versioning/equality.ts` (entityEquals so sánh diagrams)
- Test: `apps/api/src/model/diagrams-roundtrip.test.ts`

**Interfaces:**
- Consumes: commit engine + fold + equality.
- Produces:
  - Shared: `interface DiagramSpec { id: string; kind: 'system'|'sequence'; title: string; mermaid: string }`; `Entity.diagrams?: DiagramSpec[]`.
  - `diagrams_json jsonb` trên entity_versions + head_entities; CommitService ghi `diagramsJson: entity.diagrams ?? null`; foldHeadState trả `diagrams`.
  - `entityEquals` thêm so sánh `diagrams` **theo thứ tự** (deepEqual — diagram có thứ tự hiển thị).

- [ ] **Step 1: Write failing test (Review Focus)** — commit một entity có `diagrams:[{id,kind:'sequence',title,mermaid}]` ⇒ foldHeadState trả lại đúng diagrams; commit update đổi mermaid ⇒ diff thấy `updated`; reorder/nội dung giống ⇒ bằng nhau.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** shared type + cột + migration + map commit/fold + entityEquals.
- [ ] **Step 4: Run** — PASS + full api suite không regress.
- [ ] **Step 5: Commit** — `feat: entity.diagrams versioned field (mermaid system/sequence)`.

## Task 6: FE Mermaid render + editor input

**Files:**
- Create: `apps/web/src/diagram/MermaidDiagram.tsx`
- Modify: `apps/web/src/viewer/DocViewer.tsx` (render diagrams[] bằng mermaid, song song react-flow flow cũ), `apps/web/src/editor/EntityEditor.tsx` (khu vực Diagrams: thêm/sửa, chọn kind, nhập mermaid, preview), `apps/web/package.json` (mermaid)
- Test: `apps/web/src/diagram/MermaidDiagram.test.tsx`, `apps/web/src/editor/EntityEditor.test.tsx` (diagrams)

**Interfaces:**
- Consumes: Entity.diagrams (Task 5), api createEntity/updateEntity.
- Produces: `MermaidDiagram({ mermaid, kind })` render SVG đã sanitize (mermaid securityLevel:'strict' + DOMPurify). DocViewer render từng diagram + flow react-flow cũ nếu có. EntityEditor cho nhập mảng diagrams và lưu qua commit.

- [ ] **Step 1: Write failing tests (Review Focus)** — MermaidDiagram: mermaid hợp lệ render ra `<svg>`; mermaid chứa payload script bị sanitize (không còn `<script>` trong DOM). EntityEditor: thêm một diagram system + lưu ⇒ createEntity nhận entity có diagrams[0].kind='system'.
- [ ] **Step 2: Run** — `npm run -w apps/web test` — FAIL.
- [ ] **Step 3: Implement** MermaidDiagram + wire DocViewer + EntityEditor diagrams.
- [ ] **Step 4: Run** — PASS + build; react-flow cũ vẫn render (giữ nhánh flow).
- [ ] **Step 5: Commit** — `feat(web): mermaid diagram render + editor input`.

---

# SLICE C — Upload + tóm tắt (Task 7–9)

## Task 7: Files table + storage + upload/download endpoints

**Files:**
- Modify: `apps/api/src/db/schema.ts` (bảng `files`), migration, `apps/api/src/app.module.ts`
- Create: `apps/api/src/files/storage.ts` (filesystem blob + STORAGE_TOKEN), `files.service.ts`, `files.module.ts`, `files.controller.ts`
- Test: `apps/api/src/files/files.controller.test.ts`

**Interfaces:**
- Consumes: DB_TOKEN; multer/FileInterceptor.
- Produces:
  - `files(id uuid pk, project_id uuid fk, entity_id text null, filename, mime, size_bytes bigint, storage_path, extracted_chars int null, summary_status text default 'pending', created_at)`.
  - `FilesService.save(projectId, file)`, `get(id)`, `openStream(id)`. Storage ghi `/<DATA_DIR>/files/<projectId>/<uuid>-<name>`.
  - HTTP: `POST /projects/:projectId/files` (multipart, 1 file) → `{ fileId, summaryStatus:'pending' }`; `GET /files/:id/download` stream; `GET /files/:id` metadata. Giới hạn kích thước (builder chọn, mặc định ~20MB) + whitelist mime (.pdf/.docx/.md).

- [ ] **Step 1: Write failing test** — POST một file .md vào project ⇒ 201 + files row (project_id đúng, summary_status 'pending'); GET download trả lại nội dung; mime ngoài whitelist ⇒ 400.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** storage + service + controller + migration.
- [ ] **Step 4: Run** — PASS + build.
- [ ] **Step 5: Commit** — `feat(api): file upload/download + storage + files table`.

## Task 8: Ingest (trích text + LLM tóm tắt → entity, nền)

**Files:**
- Create: `apps/api/src/ingest/extract.ts` (.pdf/.docx/.md → text), `ingest.service.ts`, (tái dùng worker loop)
- Modify: `apps/api/src/boot/worker.ts` (drain ingest/summary jobs), `apps/api/package.json` (mammoth, pdf-parse)
- Test: `apps/api/src/ingest/extract.test.ts`, `ingest.service.test.ts` (LLM mock)

**Interfaces:**
- Consumes: FilesService, LlmPort, CommitService, ensureProjectMain.
- Produces:
  - `extractText(path, mime): Promise<string>` — mammoth cho docx, pdf-parse cho pdf, đọc thẳng md. Lỗi/parse hỏng/file rỗng ⇒ throw có phân loại.
  - `IngestService.runPending(): Promise<number>` — với mỗi file `summary_status='pending'`: trích text → `LlmPort.complete` sinh tóm tắt ngắn → `CommitService.commit` tạo/cập nhật một entity tài liệu trên branch main của project (type mặc định builder chọn, vd 'tsd'; group/tier mặc định; contentMarkdown = tóm tắt + link tải file) → set `files.entity_id` + `summary_status='done'`; lỗi ⇒ `summary_status='failed'` (không treo).
  - Worker loop gọi `IngestService.runPending()` cạnh `IndexerService.runPending()`.

- [ ] **Step 1: Write failing tests (Review Focus)** — extract .md/.docx/.pdf fixture trả text; file rỗng/parse hỏng ⇒ status 'failed' (không 'pending' mãi). ingest (LLM mock): một file pending ⇒ runPending tạo entity có contentMarkdown = tóm tắt mock, gắn vào main của project, files.entity_id set, status 'done'; chạy lần 2 xử lý 0.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** extract + IngestService + worker wiring.
- [ ] **Step 4: Run** — PASS + build.
- [ ] **Step 5: Commit** — `feat(api): ingest pipeline — extract + LLM summary -> entity`.

## Task 9: FE upload page + status poll

**Files:**
- Create: `apps/web/src/routes/UploadPage.tsx`
- Modify: `apps/web/src/main.tsx` (route `/projects/:projectId/upload`), `apps/web/src/api/client.ts` (uploadFile, getFile), `apps/web/src/App.tsx` (link tới upload)
- Test: `apps/web/src/routes/UploadPage.test.tsx`

**Interfaces:**
- Consumes: POST /projects/:id/files, GET /files/:id.
- Produces: `uploadFile(projectId, file)`, `getFile(fileId)`. UploadPage: chọn file → upload → hiện trạng thái (pending/done/failed) bằng poll getFile; khi done link tới entity tạo ra.

- [ ] **Step 1: Write failing test** — mock uploadFile trả {fileId,status:'pending'}, getFile sau đó trả 'done' ⇒ UI chuyển từ pending sang done và hiện link entity.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** UploadPage + client + route.
- [ ] **Step 4: Run** — PASS + build.
- [ ] **Step 5: Commit** — `feat(web): upload page + ingest status poll`.

---

# SLICE D — Pattern Wiki (Task 10–12)

## Task 10: entity.appliesPatterns versioned field

**Files:**
- Modify: `packages/shared/src/index.ts` (Entity thêm `appliesPatterns?: string[]`), `apps/api/src/db/schema.ts` (`applies_patterns_json` trên entity_versions + head_entities), migration, `commit.service.ts`, `fold.ts`, `equality.ts`
- Test: `apps/api/src/model/applies-patterns-roundtrip.test.ts`

**Interfaces:**
- Produces: `Entity.appliesPatterns?: string[]` (mảng pattern slug); `applies_patterns_json jsonb`; commit/fold map; `entityEquals` so sánh như SET (giống tags).

- [ ] **Step 1: Write failing test (Review Focus)** — commit entity có `appliesPatterns:['singleton','cqrs']` ⇒ fold trả lại; reorder ⇒ bằng nhau (set); thêm phần tử ⇒ updated.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** shared + cột + migration + map + entityEquals (set compare).
- [ ] **Step 4: Run** — PASS + full api suite không regress.
- [ ] **Step 5: Commit** — `feat: entity.appliesPatterns versioned field`.

## Task 11: Patterns catalog + CRUD + seed + used-by

**Files:**
- Modify: `apps/api/src/db/schema.ts` (bảng `patterns`), migration + seed patterns, `apps/api/src/app.module.ts`
- Create: `apps/api/src/patterns/pattern.service.ts`, `patterns.module.ts`, `patterns.controller.ts`, `dto.ts`, `apps/api/data/patterns-seed.json`
- Test: `apps/api/src/patterns/pattern.service.test.ts`, `patterns.controller.test.ts`

**Interfaces:**
- Produces:
  - `patterns(id uuid pk, slug text unique, name, category text, intent, when_to_use, pros, cons, mermaid text null, kind text null, created_at)`.
  - `PatternService.list()`, `get(slug)`, `create/update/remove`, `usedBy(slug)` — quét **head_entities của branch main mỗi project** tìm entity có slug trong `applies_patterns_json` → `[{projectId, projectName, entityId, code, title}]`.
  - HTTP: `GET /patterns`, `GET /patterns/:slug`, `POST/PATCH/DELETE /patterns`, `GET /patterns/:slug/used-by`.
  - Seed khởi tạo: vài GoF (singleton/factory/observer/strategy/adapter) + vài System Design (cqrs/saga/outbox/circuit-breaker/api-gateway), mỗi cái có mermaid khái niệm. Seed chạy ở bootstrap (idempotent theo slug).

- [ ] **Step 1: Write failing tests** — GET /patterns trả seed (>0, có 'singleton'); used-by: gán 'cqrs' cho một entity trên main của một project ⇒ used-by('cqrs') trả entity đó; một gán trên candidate (chưa merge) KHÔNG xuất hiện (chỉ main — Global Constraint).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** bảng + seed + service (incl. used-by quét main) + controller.
- [ ] **Step 4: Run** — PASS + build.
- [ ] **Step 5: Commit** — `feat(api): pattern catalog + used-by (main only)`.

## Task 12: FE Pattern Wiki + gán pattern cho entity

**Files:**
- Create: `apps/web/src/routes/PatternWiki.tsx`, `PatternDetail.tsx`
- Modify: `apps/web/src/main.tsx` (routes `/patterns`, `/patterns/:slug`), `apps/web/src/api/client.ts` (patterns fns), `apps/web/src/editor/EntityEditor.tsx` (chọn appliesPatterns), `apps/web/src/App.tsx` (link tới /patterns)
- Test: `apps/web/src/routes/PatternWiki.test.tsx`, `PatternDetail.test.tsx`

**Interfaces:**
- Consumes: /patterns, /patterns/:slug, /patterns/:slug/used-by; Entity.appliesPatterns.
- Produces: `listPatterns()`, `getPattern(slug)`, `getPatternUsedBy(slug)`. PatternWiki: list theo category. PatternDetail: intent/when/pros/cons + MermaidDiagram (tái dùng Task 6) + "Used by" (link tới project/entity). EntityEditor: multi-select appliesPatterns từ catalog, lưu qua commit.

- [ ] **Step 1: Write failing tests** — PatternWiki list render theo category; PatternDetail render mermaid + used-by list (mock). EntityEditor: chọn 'singleton' ⇒ createEntity nhận appliesPatterns chứa 'singleton'.
- [ ] **Step 2: Run** — `npm run -w apps/web test` — FAIL.
- [ ] **Step 3: Implement** wiki + detail + client + editor appliesPatterns + routes.
- [ ] **Step 4: Run** — PASS + build.
- [ ] **Step 5: Commit** — `feat(web): pattern wiki + apply-pattern editor`.

---

# SLICE E — Infra + e2e (Task 13)

## Task 13: Compose wiring + e2e smoke mở rộng

**Files:**
- Modify: `infra/docker-compose.yml` (volume cho blob files; DATA_DIR env; worker drain cả ingest), `apps/api/Dockerfile` (mammoth/pdf-parse deps), `apps/api/src/boot/bootstrap-db.ts` (seed thành project demo + seed patterns), `scripts/e2e-smoke.mjs` (mở rộng), `README.md`
- Test: `scripts/e2e-smoke.mjs`

**Interfaces:**
- Produces: stack chạy với volume files; bootstrap tạo project demo "CorpDigi" + seed graph vào main của nó + seed patterns; worker drain embedding + ingest.
- e2e smoke mở rộng (chạy live qua podman): tạo project thứ 2 → upload một .md vào project 2 → chờ ingest done → hỏi RAG project 2 có citation tài liệu vừa upload, và hỏi RAG project 1 KHÔNG thấy nó (cô lập); GET /patterns có seed; gán pattern cho một entity project 1 → used-by trả entity đó.

- [ ] **Step 1: Write (mở rộng) smoke** — các bước trên, fail-loud.
- [ ] **Step 2: Run (stack chưa build)** — FAIL.
- [ ] **Step 3: Implement** compose volume + bootstrap seed project/patterns + worker ingest + Dockerfile deps.
- [ ] **Step 4: Bring up + smoke** — `podman compose -f infra/docker-compose.yml up -d --build` (qua WSL) rồi `node scripts/e2e-smoke.mjs` — PASS.
- [ ] **Step 5: Commit** — `feat(infra): multi-project + files volume + patterns seed + extended e2e`.
