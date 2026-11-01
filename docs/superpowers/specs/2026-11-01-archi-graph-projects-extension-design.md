# Archi-Graph — Mở rộng: Projects / Upload / Diagram / Pattern Wiki — Design Document

> Mở rộng platform v1 (versioned knowledge-graph) thành một site đa-project kiểu archflow:
> trang chủ Projects, các trang nhập liệu (upload tài liệu + metadata + diagram), và một
> Pattern Wiki liên kết vào graph từng project.
> Trạng thái: **bản thảo chờ duyệt** — chưa viết code cho tới khi được chấp thuận.
> Ngày: 2026-11-01
> Nền tảng: mở rộng trực tiếp trên nhánh `feat/platform-v1` (apps/api, apps/web, packages/shared).

---

## 1. Intent & Why

### Vấn đề
Platform v1 đã có versioned-graph + viewer + react-flow (read-only) + RAG local, nhưng:
- Chỉ có **một model toàn cục** (branch `main` duy nhất) — không quản được nhiều hệ thống/kiến
  trúc song song.
- **Không upload được tài liệu thật** (chỉ nhập markdown trong app; `links[]` là URL ngoài).
- **Không soạn được sơ đồ** — react-flow chỉ xem; không có editor, không phân loại System/Sequence.
- Design pattern chỉ là **5 node `dp` trộn trong graph** (toàn pattern kiến trúc), không phải một
  thư viện tham khảo kinh điển (GoF / System Design).

### Điều muốn xây
Một site đa-project, 1 người dùng, local-first:
- **Trang chủ Projects**: liệt kê project; click một project → load dữ liệu project đó và hiển thị
  đúng giao diện graph hiện tại (3D graph + viewer + detail), scoped theo project.
- **Các trang nhập liệu** (trong một project): upload tài liệu (.pdf/.docx/.md) → trích text →
  **LLM tóm tắt ngắn** → lưu tóm tắt làm nội dung + index RAG; nhập metadata; nhập **sơ đồ bằng
  cú pháp Mermaid** (System + Sequence) render trực tiếp.
- **Pattern Wiki**: catalog pattern thông dụng (GoF + System Design) dạng wiki (mô tả + sơ đồ),
  **liên kết vào graph từng project** — một component có thể "áp dụng" pattern, và trang pattern
  truy ngược "ai đang dùng".

### Tại sao bây giờ
v1 chứng minh được lõi versioned-graph + RAG hoạt động. Giá trị kế tiếp là biến nó từ "một mô
hình" thành "nơi quản nhiều kiến trúc", nhập liệu được bằng tài liệu thật + sơ đồ, và nối tri thức
pattern vào — đúng khoảng trống archflow nhắm tới.

### Success nhìn như thế nào
1. Trang chủ hiện ≥1 project; tạo project mới được; click vào → thấy graph của riêng project đó.
2. Upload một .pdf/.docx/.md vào project → hệ thống lưu file, trích text, LLM tóm tắt, tạo một
   entity tài liệu với nội dung là bản tóm tắt, và hỏi RAG được về nó — **không lẫn sang project khác**.
3. Soạn một System diagram và một Sequence diagram bằng Mermaid trên entity → render đúng.
4. Mở Pattern Wiki → xem pattern (vd Singleton, CQRS) kèm sơ đồ; gán pattern cho một component
   trong project; trang pattern hiện component/project đang dùng nó.

---

## 2. Goals / Non-Goals / Anti-Goals

### Goals
- **Multi-project** (hướng A): bảng `projects`; `project_id` trên `branches`; mọi read/seed/boot
  thành project-aware; RAG tables (`doc_chunks`/`embedding_jobs`) thêm chiều cô lập để không nhiễm chéo.
- **Trang chủ Projects** + CRUD project (tạo/đổi tên/xoá); chọn project → vào graph hiện tại.
- **Upload**: endpoint multipart; blob store trên filesystem; bảng `files`; trích text .pdf/.docx/.md;
  LLM tóm tắt; tạo/ gắn entity tài liệu với nội dung = tóm tắt; index RAG trong đúng project.
- **Diagram Mermaid**: entity mang nguồn Mermaid + loại (`system`|`sequence`); render bằng thư viện
  `mermaid` ở FE; **song song** react-flow cũ (giữ nguyên render flow react-flow cho dữ liệu cũ).
- **Pattern Wiki (hướng A)**: catalog pattern toàn cục (CRUD + mô tả + sơ đồ Mermaid); entity trong
  project mang `appliesPatterns: [patternId]`; trang wiki truy ngược "ai dùng".
- Giữ nguyên lõi versioned-graph/merge/blast/diff của v1 — chỉ **thêm chiều project**, không viết lại.

### Non-Goals (đợt này)
- Auth / multi-user / owner trên project (vẫn 1 user; `projects` không có owner).
- Trích xuất ảnh / OCR; chỉ .pdf/.docx/.md.
- Kéo-thả node/edge trên canvas để soạn diagram (dùng cú pháp Mermaid thay thế).
- Versioning cho pattern catalog (catalog là CRUD thường, không commit/branch).
- Chuyển react-flow cũ sang Mermaid (giữ song song).
- S3/MinIO (blob trên filesystem volume).

### Anti-Goals (làm hỏng dù "chạy")
- **Nhiễm chéo giữa project**: RAG trả lời lẫn tài liệu project khác; graph một project hiện node
  của project khác. Phải cô lập tuyệt đối theo project.
- Phá giả định "quan hệ trong cùng branch" của engine (lý do chọn hướng A cho pattern, không mở
  relation xuyên-project).
- Upload chặn request / tóm tắt LLM chạy trong request handler làm treo API.
- Mermaid render bằng cách nhúng HTML chưa sanitize (XSS).

---

## 3. Constraints

- **Stack theo v1 (lựa chọn của tôi):** NestJS + Drizzle + Postgres/pgvector; Vite+React+TS; Ollama
  (tóm tắt + embedding); Podman Compose.
  - Trích text: **mammoth** (.docx), **pdf-parse** hoặc **pdfjs-dist** (.pdf), đọc thẳng (.md).
  - Blob: **filesystem** trong volume container (local-first). Bảng `files` lưu metadata + đường dẫn.
  - Mermaid: thư viện **mermaid** ở FE; nguồn Mermaid lưu trong DB; render sanitize (DOMPurify trên
    SVG đầu ra hoặc dùng mermaid securityLevel='strict').
- **1 user, local-first**; không auth.
- Tái dùng commit engine / head-state / branch / diff / merge / blast / RAG của v1; chỉ thêm `project_id`.
- Giữ react-flow cho dữ liệu cũ; Mermaid cho dữ liệu mới.
- FE hiện **không có router** — đợt này thêm điều hướng đa trang (xem §5.6, quyết định router vs
  state-switch là lựa chọn builder, mặc định nêu bên dưới).

### 3.1. Hiện trạng v1 được tái dùng (từ khảo sát context-gatherer)
- `branches(id,name,head_commit_id,parent_commit_id,author,created_at)` — **chưa có project_id**.
- `head_entities`/`head_relations` khoá `(branch_id, …)` — đã cô lập theo branch.
- `doc_chunks`/`embedding_jobs` khoá theo `entity_id`/`commit_id` — **CHƯA có chiều branch/project**
  → nguồn nhiễm chéo (seed dùng id người-đọc như `dp-mfe`). Phải thêm scope.
- `Entity.flow: unknown|null`, lưu `flow_json`. `links: LinkRef[]` = URL ngoài.
- react-flow read-only ở `apps/web/src/viewer/FlowDiagram.tsx`; `EntityEditor` hardcode `flow:null`.
- DI: `@Global DatabaseModule` cấp `DB_TOKEN` qua `useFactory: () => getDb()`; mỗi module dùng
  provider-factory `{provide: Service, useFactory:(db)=>new Service(db), inject:[DB_TOKEN]}`.
- Seed: `bootstrap-db.prepareApiDatabase()` → `ensureMainBranch` → `importPocSeed` (một main toàn cục).

---

## 4. Approaches (các hướng đã cân nhắc)

Người dùng đã chốt từng mắt xích trong brainstorm; ghi lại các ngã rẽ.

### 4.1. Cô lập đa-project
- **(A) project_id trên branches + scope RAG tables — ĐÃ CHỌN.** Ít đổi schema nhất; giữ nguyên
  engine; head tables đã cô lập theo branch.
- (B) Tách hẳn (DB/schema riêng mỗi project) — loại: phức tạp, thừa cho 1 user local.

### 4.2. Pattern ↔ graph
- **(A) Catalog toàn cục riêng + entity.appliesPatterns[patternId]; wiki quét ngược — ĐÃ CHỌN.**
  Không đụng lõi relation/merge/blast.
- (B) Pattern là entity trong "project thư viện" + relation xuyên-project — loại: phá giả định
  "quan hệ cùng branch" của engine.

### 4.3. Soạn diagram
- **Nhập cú pháp text Mermaid rồi render (System + Sequence) — ĐÃ CHỌN**, song song react-flow cũ.
- Kéo-thả react-flow để soạn — loại (đợt này): editor nặng, Sequence không hợp kéo-thả.

### 4.4. Upload
- **Lưu file + trích text + LLM tóm tắt ngắn → nội dung entity + RAG — ĐÃ CHỌN.** .pdf/.docx/.md.
- Đưa nguyên văn vào RAG / OCR ảnh — loại (đợt này).

### 4.5. Chiến lược xây dựng
- **Vertical slices, Projects trước — ĐÃ CHỌN.** (a)Projects → (b)Mermaid → (c)Upload → (d)Pattern.
- Một đợt lớn lõi-trước — loại: lâu thấy kết quả, khó review ở quy mô tính-năng-trên-nền-ổn-định.

---

## 5. Mô hình dữ liệu & kiến trúc (phần "how" cốt lõi)

> Mô hình dưới là đề xuất của tôi; builder tinh chỉnh chi tiết cột nhưng giữ bất biến ở §5.7.

### 5.1. Projects + scope
```
projects ( id uuid pk, name text, description text, created_at timestamptz )
```
- `branches` thêm cột `project_id uuid NOT NULL` (FK → projects.id). Mỗi project có branch `main`
  riêng + các candidate riêng.
- **Migration dữ liệu cũ (lựa chọn của tôi):** migration tạo một **project demo mặc định**
  ("CorpDigi" — khớp seed POC), rồi **backfill `project_id` của MỌI branch hiện có về project demo
  đó** trước khi đặt cột `NOT NULL`. Các candidate hiện có (nếu còn) đi theo cùng project demo
  (chúng fork từ main của model cũ). Thứ tự an toàn: thêm cột nullable → tạo project demo →
  UPDATE tất cả branches.project_id = demo → ALTER SET NOT NULL + FK. Không branch nào mồ côi.
- **Cô lập RAG:** thêm `branch_id uuid` (hoặc `project_id`) vào `doc_chunks` và `embedding_jobs`.
  Lựa chọn của tôi: thêm **`project_id`** vào cả hai (cùng với `entity_id, commit_id`), và RAG
  query lọc theo `project_id` của project đang xem — không chỉ dựa `entity_id` (vốn có thể trùng
  giữa project). Lý do: id entity do người đặt, trùng được; project_id là ranh giới cô lập chắc chắn.
- **Bắt buộc enforce trong truy vấn (không chỉ lưu để sau):** RAG hiện lọc bằng JOIN `head_entities`
  theo `entity_id`+`branch_id`. Vì `entity_id` trùng được giữa project, JOIN hiện tại là **lỗ rò
  cross-project**. Nên `RagService.query` **phải thêm điều kiện `doc_chunks.project_id = :projectId`**
  (hoặc join qua branch→project), và phải có **test cô lập** chứng minh 2 project cùng id entity
  không trả lẫn chunk của nhau. Đây là hệ quả trực tiếp của anti-goal "không nhiễm chéo" (§2).
  Đây là chỗ DUY NHẤT trong lõi phải sửa truy vấn — không đổi commit/head-state/diff/merge/blast.

### 5.2. Engine thành project-aware (thay đổi tối thiểu)
- `ensureMainBranch(db)` → `ensureProjectMain(db, projectId)`: tìm branch `name='main' AND
  project_id=projectId`, tạo nếu thiếu. (Giữ `ensureMainBranch` như wrapper tương thích nếu cần cho seed.)
- `BranchService.listBranches()` → `listBranches(projectId)` lọc theo project.
- `createCandidate(name, fromBranchId)`: candidate kế thừa `project_id` của branch cha.
- Commit engine (`CommitService.commit`) **không đổi logic**, chỉ cần branch đã mang project_id;
  khi enqueue `embedding_jobs` ghi kèm `project_id` của branch.
- Diff/merge/blast: không đổi (chúng thao tác trong phạm vi branch, mà branch đã thuộc một project).
- **Bất biến giữ nguyên:** commit immutable; head-state materialized; merge referential; blast CTE.

### 5.3. Files / Upload
```
files ( id uuid pk, project_id uuid fk, entity_id text null, filename text, mime text,
        size_bytes bigint, storage_path text, extracted_chars int null,
        summary_status text default 'pending', created_at timestamptz )
```
- Endpoint multipart (NestJS `FileInterceptor`/multer) → lưu blob vào volume
  (`/data/files/<project_id>/<uuid>-<filename>`), ghi `files` row.
- **Trích + tóm tắt chạy NỀN** (không trong request): một job (tái dùng mô hình `embedding_jobs`
  nền của v1, hoặc bảng `summary_jobs` tương tự) → trích text theo mime → gọi `LlmPort.complete`
  sinh tóm tắt ngắn → tạo/cập nhật một entity tài liệu (type phù hợp, vd `tsd`/`lld`/một type tài
  liệu) với `contentMarkdown` = tóm tắt (+ link tải file gốc qua `files`) → commit vào branch `main`
  của project → enqueue embedding như bình thường. Request upload trả về ngay với `files` row
  `summary_status:'pending'`; FE poll trạng thái.
  - **Cơ chế commit (lựa chọn của tôi):** job nền **dùng lại `CommitService.commit`** để tạo/cập
    nhật entity tài liệu trên branch `main` của project (một commit `add`/`update` bình thường,
    atomic, tự advance head + enqueue embedding). Đây là commit "do hệ thống" (author='local'),
    xảy ra bất đồng bộ trên baseline — chấp nhận được vì v1 là 1 user, không có người khác đang
    sửa `main` đồng thời; và nó giữ mọi bất biến versioning (không có đường ghi entity nào khác
    ngoài commit engine). Nếu muốn an toàn hơn với đa người sau này, có thể cho ingest ghi vào một
    candidate riêng rồi người dùng merge — để future-work, KHÔNG làm đợt này.
- Tải file gốc: endpoint `GET /files/:id/download` stream từ storage_path (chỉ trong project).

### 5.4. Diagram (Mermaid) — song song react-flow
- Mở rộng `Entity`:
  - `diagrams?: { id: string; kind: 'system'|'sequence'; title: string; mermaid: string }[]`
    (lưu trong một cột jsonb mới `diagrams_json`, HOẶC gộp vào một cột `extras_json` — builder chọn;
    mặc định cột riêng `diagrams_json` để không đụng `flow_json` cũ).
- **`diagrams` và `appliesPatterns` (§5.5) là FIELD VERSIONED hạng nhất của entity** — đi qua đúng
  đường commit → entity_versions → head-state → fold → diff → merge như mọi field entity khác
  (KHÔNG phải bảng phụ). Nghĩa là: thêm cột vào `entity_versions` + `head_entities`, map trong
  `CommitService.commit` và `foldHeadState`, đưa vào so sánh của diff/merge (`equality.ts`
  entityEquals — thêm so sánh hai field này; `diagrams` so theo thứ tự, `appliesPatterns` so như SET
  giống tags/links). Lý do: chúng là nội dung mô hình, phải versioned/branch/merge được như phần còn lại.
- `flow` (react-flow json) **giữ nguyên** cho dữ liệu cũ. Viewer: nếu entity có `flow` → render
  react-flow (như cũ); nếu có `diagrams[]` → render từng diagram bằng **mermaid**. Cả hai có thể
  cùng xuất hiện.
- Nhập liệu: `EntityEditor` thêm khu vực "Diagrams": chọn loại (System/Sequence), nhập mermaid,
  preview render. Lưu qua `createEntity`/`updateEntity` (commit như mọi thay đổi entity).
- **Render an toàn:** mermaid `securityLevel: 'strict'`; sanitize SVG đầu ra bằng DOMPurify trước
  khi chèn DOM.

### 5.5. Pattern catalog (toàn cục) + liên kết (hướng A)
```
patterns ( id uuid pk, slug text unique, name text, category text,  -- 'gof' | 'system-design' | ...
           intent text, when_to_use text, pros text, cons text,
           mermaid text null, kind text null,   -- sơ đồ khái niệm (mermaid)
           created_at timestamptz )
```
- Catalog **toàn cục**, không gắn project, CRUD thường (không versioning).
- Liên kết: `Entity` thêm `appliesPatterns?: string[]` (mảng `patterns.slug` hoặc `patterns.id`;
  lựa chọn của tôi: **slug** cho ổn định & người đọc được), lưu jsonb `applies_patterns_json`.
- Trang Pattern Wiki: danh sách + chi tiết (intent/when/pros/cons + sơ đồ mermaid). "Used by": quét
  head-state các project tìm entity có pattern slug đó → liệt kê (project, entity code/title).
  - **Phạm vi "Used by" (lựa chọn của bạn): CHỈ quét branch `main` của mỗi project** — không quét
    candidate chưa merge. "Used by" phản ánh trạng thái đã chốt/chính thức (đúng tinh thần
    "evidence"), tránh nhiễu từ các candidate thử nghiệm. (Gán pattern trên một candidate chỉ xuất
    hiện trong "Used by" sau khi candidate đó được merge vào main.)
- Seed catalog: một bộ pattern khởi tạo (vài GoF: Singleton/Factory/Observer/Strategy/Adapter… +
  vài System Design: CQRS/Saga/Outbox/Circuit-Breaker/API-Gateway…). Builder chọn danh sách khởi
  tạo hợp lý; đây là seed dữ liệu, không phải logic.

### 5.6. FE điều hướng đa trang
- Thêm **react-router** (lựa chọn của tôi) — sạch hơn state-switch cho đa trang thật:
  - `/` → Trang chủ Projects (list + tạo).
  - `/projects/:projectId` → giao diện graph hiện tại (App 3-panel), scoped theo projectId.
  - `/projects/:projectId/upload` (hoặc tab trong editor) → trang nhập liệu/upload.
  - `/patterns` + `/patterns/:slug` → Pattern Wiki.
- App hiện tại được bọc lại: state `branchId` resolve theo **project main** của `:projectId` (thay
  vì 'main' toàn cục). `listBranches` → theo project.
- (Phương án thay thế builder có thể cân nhắc nếu muốn tránh thêm dependency: top-level
  `view` state switch. Mặc định của tôi là react-router.)

### 5.7. Bất biến (builder phải giữ)
- Cô lập project tuyệt đối: mọi read graph/RAG lọc theo project; không truy vấn nào trả dữ liệu
  cross-project (trừ Pattern "used-by" vốn cố ý quét nhiều project, nhưng chỉ đọc danh mục áp dụng).
- Lõi versioned-graph (commit immutable, head-state, diff/merge/blast) **không đổi hành vi**.
- Upload/tóm tắt chạy nền; request không chặn trên LLM/trích xuất.
- Mermaid & markdown & file links đều sanitize trước khi vào DOM.
- react-flow cũ vẫn render được (không regress dữ liệu pattern/landscape cũ).

---

## 6. Kiến trúc dịch vụ (module mới)

```
apps/api/src/
  projects/   ProjectsModule   (projects CRUD, ensureProjectMain)        -> DB_TOKEN
  files/      FilesModule      (multipart upload, download, storage)     -> DB_TOKEN + STORAGE_TOKEN
  ingest/     IngestService    (nền: trích text + LLM tóm tắt -> entity) -> DB_TOKEN + LLM_TOKEN
  patterns/   PatternsModule   (catalog CRUD + used-by quét project)     -> DB_TOKEN
  (model/versioning/analysis/rag: thêm project scope, không đổi lõi)
apps/web/src/
  routes/     ProjectsHome, ProjectGraph (bọc App cũ), UploadPage, PatternWiki, PatternDetail
  diagram/    MermaidDiagram.tsx (render mermaid, sanitize)
  (editor/EntityEditor: thêm Diagrams + appliesPatterns; viewer: render mermaid song song react-flow)
```
Theo đúng DI provider-factory của v1; module mới thêm vào `AppModule.imports`. Một tiến trình nền
(worker đã có) xử lý thêm `summary`/ingest jobs ngoài commit path.

### Lộ trình (slices)
- **Slice A — Projects nền**: `projects` table + `project_id` trên branches + scope RAG tables;
  `ensureProjectMain`; `listBranches(projectId)`; ProjectsModule + CRUD; migrate seed POC thành một
  project demo; FE: react-router + Trang chủ Projects + bọc App theo `:projectId`. (Backend test +
  FE test; e2e: tạo project, vào graph, không lẫn project.)
- **Slice B — Mermaid diagram**: `diagrams_json` + shared type; EntityEditor nhập/preview; viewer
  render mermaid (sanitize) song song react-flow; (test render + lưu).
- **Slice C — Upload + tóm tắt**: `files` table + storage; multipart upload/download; ingest nền
  (trích .pdf/.docx/.md + LLM tóm tắt → entity → RAG trong project); FE trang upload + poll trạng
  thái. (test trích/tóm tắt với LLM mock; e2e upload→hỏi RAG trong project.)
- **Slice D — Pattern Wiki**: `patterns` catalog + CRUD + seed; `appliesPatterns` trên entity;
  FE Pattern Wiki (list/detail + mermaid) + gán pattern cho entity + "used-by" quét project.

Mỗi slice là một đợt review/commit riêng, có deliverable test được độc lập.

---

## 7. Những gì để lại cho builder quyết
- Chi tiết cột/ràng buộc Postgres cho `projects`/`files`/`patterns` + cột jsonb mới
  (`diagrams_json`, `applies_patterns_json`); chỉ mục.
- Thư viện trích xuất cụ thể (pdf-parse vs pdfjs-dist) + xử lý lỗi/parse hỏng; giới hạn kích thước file.
- Cơ chế job nền cho ingest (tái dùng `embedding_jobs` style hay bảng `summary_jobs` riêng).
- react-router vs top-level view-switch (mặc định router).
- `appliesPatterns` tham chiếu slug hay id (mặc định slug); danh sách pattern seed khởi tạo.
- Cách entity "tài liệu upload" chọn `type`/`group`/`tier` mặc định khi tạo từ file.
- Cấu trúc thư mục FE routes/components chi tiết.

## 8. Verification
- **Slice A**: test backend (projects CRUD, ensureProjectMain idempotent, listBranches lọc project,
  RAG/graph cô lập giữa 2 project — không lẫn). FE: trang chủ list/tạo, vào graph theo project.
  e2e: 2 project, mỗi project graph riêng, hỏi RAG không lẫn.
- **Slice B**: lưu diagram mermaid, viewer render (system + sequence), sanitize; react-flow cũ không regress.
- **Slice C**: trích text .pdf/.docx/.md (fixture), LLM-mock tóm tắt → entity có nội dung tóm tắt +
  index; upload/download; cô lập theo project. e2e với Ollama thật trong compose.
- **Slice D**: patterns CRUD + seed; gán appliesPatterns cho entity; used-by quét đúng; mermaid pattern render.
- Mỗi slice: chạy build/test của app trước khi coi là xong; DB test qua podman pgvector; không regress 109 test v1.

## 9. Mở đường tương lai (ngoài đợt này)
- Auth/multi-user + owner project.
- OCR ảnh; thêm định dạng upload.
- Kéo-thả soạn diagram; thống nhất react-flow↔mermaid.
- Versioning cho pattern catalog; pattern do người dùng đóng góp.
- Thống nhất RAG ingest nguyên-văn (không chỉ tóm tắt) tùy chọn.
