# Archi-Graph Platform — Design Document

> Nâng POC single-file `index.html` thành một **platform quản lý tài liệu kiến trúc** theo
> hướng knowledge-graph + llm-wiki + architect-flow (lấy cảm hứng từ archflow.net).
> Trạng thái: **bản thảo chờ duyệt** — chưa viết code cho tới khi được chấp thuận.
> Ngày: 2026-10-31

---

## 1. Intent & Why

### Vấn đề
POC hiện tại (`index.html`, ~2000 dòng) đã chứng minh được **phần nhìn**: một Knowledge
Graph 3D (three.js) cho tài liệu kiến trúc CorpDigi, viewer Markdown, react-flow cho flow &
design pattern, đồng bộ hai chiều, filter, 2D/3D. Nhưng nó là single-file `file://`, dữ liệu
nhúng cứng, không sửa được, không có phiên bản, không có AI.

Điều chúng ta muốn xây là một **platform thực thụ** nơi:
- Con người **dựng mô hình kiến trúc trong app**; database của platform là **source of truth**
  ("living model" — giống archflow.net).
- Mô hình có **phiên bản đầy đủ**: tạo bản *candidate/branch*, mô phỏng thay đổi, so sánh
  **blast radius** với baseline, rồi merge. (Đây là "Workbench simulation" của archflow.)
- Một lớp **LLM hỏi–đáp (RAG)** trên nội dung tài liệu, mọi câu trả lời **dẫn nguồn** về tài
  liệu gốc ("evidence, not ceremony").

### Tại sao bây giờ
POC đã trả lời xong câu hỏi "trực quan hoá thế nào". Giá trị kế tiếp nằm ở chỗ POC **không
chạm tới**: biến đồ thị tĩnh thành một mô hình sống, có phiên bản, suy luận được tác động của
thay đổi *trước khi* thực hiện — đúng khoảng trống mà archflow.net nhắm tới.

### Success nhìn như thế nào (cho v1)
Một người dùng, chạy local qua Docker Compose, có thể:
1. Dựng/sửa mô hình kiến trúc (node = component/tài liệu, edge = quan hệ) trong UI web.
2. Tạo một **branch candidate**, thay đổi mô hình trên đó, xem **diff** so với baseline và
   **blast radius** (những gì một thay đổi/lỗi có thể lan tới), rồi **merge** vào baseline.
3. Hỏi LLM câu hỏi bằng ngôn ngữ tự nhiên về tài liệu và nhận câu trả lời **kèm trích dẫn**
   tới tài liệu nguồn.
4. Mọi dữ liệu persistent nằm trong Postgres; POC three.js được migrate thành UI chạy trên
   build thực thụ, trỏ vào API thật.

---

## 2. Goals / Non-Goals / Anti-Goals

### Goals (v1)
- **Versioned graph là lõi**: node/edge có phiên bản, hỗ trợ branch / diff / merge.
- **Blast radius**: tính tập node/edge bị ảnh hưởng khi một node đổi/mất, lần theo quan hệ.
- **Model editor**: CRUD node, edge, tài liệu (contentMarkdown + metadata) trong UI.
- **Branch workbench**: tạo candidate, sửa trên đó, xem diff + blast radius vs baseline, merge.
- **RAG hỏi–đáp**: hỏi tự nhiên → trả lời có trích dẫn tới tài liệu (mức 1, không agentic).
- **Migrate POC**: three.js 3D graph + react-flow viewer + Markdown viewer lên Vite+React+TS,
  lấy dữ liệu từ API. Giữ các đặc trưng đã có (2D/3D, filter, đồng bộ hai chiều, collapse).
- **Local-first**: Docker Compose (web + api + postgres [+ vector store]). Không auth ở v1.

### Non-Goals (v1 — làm sau)
- Multi-user, auth, phân quyền (schema chừa sẵn `author`/ownership nhưng không hiện thực hoá).
- LLM agentic (tool-calling trên đồ thị, LLM soạn thay đổi mô hình). v1 chỉ RAG đọc.
- Connectors hút dữ liệu từ repo/OpenAPI/Confluence (đã chốt hướng A: người dựng trong app).
- Render draw.io/.docx native; xuất bản minisite/handbook kiểu archflow.
- Story mode (kể chuyện kiến trúc theo audience).

### Anti-Goals (điều khiến dự án thất bại dù "chạy được")
- **Giữ kiến trúc single-file** rồi bọc API mỏng — không gánh nổi branch/blast-radius; đã loại.
- Versioning "giả" (chỉ audit log) không cho phép branch song song + merge thực sự.
- Câu trả lời LLM **không truy ngược được về nguồn** — vi phạm nguyên tắc "evidence".
- Coupling chặt giữa UI graph và cấu trúc lưu trữ, khiến đổi mô hình phải sửa cả FE.

---

## 3. Constraints

- **Stack (lựa chọn của tôi, người dùng giao quyền chọn):**
  - FE: **Vite + React + TypeScript**, giữ **three.js** (3D graph) + **react-flow** (flow),
    **marked + DOMPurify** (Markdown). Chuyển POC từ UMD CDN sang module/build.
  - BE: **NestJS (Node + TypeScript)** — chung ngôn ngữ, chia sẻ type mô hình FE/BE.
  - Store: **Postgres** cho versioned graph (node/edge + bảng phiên bản, recursive CTE cho
    traverse/blast-radius). **pgvector** cho embedding RAG (cùng một Postgres, giảm thành phần).
  - LLM: lớp **adapter** tách rời. **v1 chạy hoàn toàn local/offline bằng Ollama** (thêm vào
    compose stack), dùng embedding model local **`nomic-embed-text` (768 chiều)** cho RAG và
    một model sinh văn bản local (ví dụ `llama3.1` hoặc tương đương) cho phần trả lời. Adapter
    cô lập sau interface để sau đổi sang API ngoài / on-prem khác mà không sửa lõi.
  - Deploy: **Docker Compose** local (web + api + postgres+pgvector + ollama + worker).
- **Local-first, single-user** ở v1 (xem Non-Goals).
- Tái dùng mô hình dữ liệu POC (documents[]/relations[]) làm điểm xuất phát cho schema.
- Giữ được các đặc trưng UI đã có của POC (đồng bộ hai chiều, 2D/3D, filter, collapse).

---

## 4. Approaches (các hướng đã cân nhắc)

Người dùng đã chọn từng mắt xích trong brainstorm; mục này ghi lại các ngã rẽ và lý do.

### 4.1. Source of truth
- (A) **Người dựng mô hình trong app, DB là source of truth** — **ĐÃ CHỌN**. Gần archflow nhất.
- (B) Sinh/đồng bộ từ repo/spec/wiki ngoài — loại: cần connectors + pipeline trích xuất, lệch
  trọng tâm v1.
- (C) Lai — loại: phức tạp nhất, để sau.

### 4.2. Mức versioning
- (1) Một mô hình sống, sửa trực tiếp — loại: không có branch/candidate.
- (2) Mô hình sống + đề xuất–review — loại: chưa có so sánh baseline song song.
- (3) **Branch/candidate đầy đủ + blast radius** — **ĐÃ CHỌN**. Là "Workbench simulation".

### 4.3. Vai trò LLM
- (1) **RAG hỏi–đáp trên tài liệu, dẫn nguồn** — **ĐÃ CHỌN**. Giữ phần AI gọn ở v1.
- (2) Agent đọc + tool-calling trên đồ thị — để sau (kiến trúc chừa chỗ).
- (3) Agent soạn thay đổi mô hình — để sau.

### 4.4. Chiến lược xây dựng
- (1) **Lõi versioned-graph trước, migrate POC sau** — **ĐÃ CHỌN**. Đi đúng xương sống khó
  nhất trước; chấp nhận UI chạy muộn, đổi lấy kiến trúc chắc.
- (2) Vertical slices — loại (dù tôi từng đề xuất): người dùng ưu tiên xương sống chắc.
- (3) Giữ single-file + API mỏng — loại: không gánh nổi mức versioning đã chọn.

### 4.5. Store cho versioned graph
- **Postgres (ĐÃ CHỌN)** vs graph DB thuần (Neo4j…). Branch/diff/merge trên mô hình *do người
  dựng* hợp với dữ liệu quan hệ có phiên bản hơn: giao dịch rõ ràng, diff theo hàng dễ kiểm
  soát, traverse bằng recursive CTE đủ cho quy mô tài liệu kiến trúc (hàng nghìn node, không
  phải hàng tỷ). Tránh thêm một hệ cơ sở dữ liệu mới phải vận hành.

---

## 5. Mô hình dữ liệu versioned-graph (phần "how" cốt lõi)

> Đây là quyết định kiến trúc quan trọng nhất. Mô hình bên dưới là **đề xuất của tôi**; một
> builder có thể tinh chỉnh chi tiết cột nhưng cần giữ bất biến nêu ở 5.4.

### 5.1. Khái niệm
- **Model**: toàn bộ không gian kiến trúc (v1 chỉ có một model).
- **Branch**: một dòng phiên bản của model. Luôn có branch `main` (baseline). Candidate là một
  branch khác, phân nhánh từ một commit của `main`.
- **Commit**: một ảnh chụp bất biến của trạng thái mô hình trên một branch tại một thời điểm.
  Branch trỏ tới commit đầu (head).
- **Entity (node)** và **Relation (edge)**: nội dung mô hình, được phiên bản theo commit.

### 5.2. Cách phiên bản hoá (copy-on-write theo commit)
Chọn mô hình **commit-snapshot bằng tham chiếu bất biến**, không copy toàn bộ mỗi commit:

```
branch        ( id, name, head_commit_id, parent_commit_id, created_at, author )
commit        ( id, branch_id, parent_commit_id, message, created_at, author )

entity_version( id, entity_id, commit_id, op, type, code, short_title, group,
                tier, title, metadata_json, content_markdown, flow_json, links_json )
relation_version( id, relation_id, commit_id, op, source_entity_id,
                  target_entity_id, kind, label )
```

> `links_json` giữ mảng `links[]` của POC (external source files: sharepoint/confluence/
> github/gitlab/drawio) như công dân hạng nhất của entity; `flow_json` giữ sơ đồ react-flow;
> `metadata_json` giữ author/date/status/tags.

- `entity_id`/`relation_id` là **danh tính bền** của một node/edge xuyên các phiên bản.
- Mỗi commit chỉ ghi **các version của entity/relation thực sự đổi** trong commit đó (`op` =
  `add | update | delete`). Trạng thái của một branch tại commit C = *fold* các version từ
  commit gốc tới C theo thứ tự, lấy bản mới nhất của mỗi `entity_id`, bỏ cái bị `delete`.
- Diff giữa hai commit = so sánh hai tập fold theo `entity_id`/`relation_id`.

> Lý do copy-on-write theo delta thay vì snapshot toàn bộ: mô hình kiến trúc đổi từng phần
> nhỏ; lưu delta giúp diff/merge rõ ràng và tiết kiệm. Đánh đổi: đọc trạng thái branch cần
> fold — giải quyết bằng **materialized head view** cho mỗi branch (xem 5.5).

### 5.3. RAG store
```
doc_chunk ( id, entity_id, commit_id, chunk_index, text, embedding vector )
```
- Embedding sinh từ `content_markdown` của entity version (chia chunk). Truy vấn RAG chạy trên
  chunk của **branch đang xem** (lọc theo tập entity_version hiện hành của branch đó).
- Trích dẫn trả về `entity_id` (+ code/short_title) để UI nhảy tới node/tài liệu nguồn.

### 5.4. Bất biến (builder phải giữ)
- `entity_id`/`relation_id` **không đổi** qua các phiên bản; chỉ `entity_version` mới thêm.
- Không bao giờ ghi đè commit đã tạo (bất biến); thay đổi = commit mới.
- Mọi câu trả lời RAG phải gắn được về ít nhất một `entity_id` nguồn.
- Schema mang sẵn cột `author` ở `branch`/`commit`/version để thêm multi-user sau mà không đổi
  cấu trúc (v1 ghi giá trị mặc định "local").

### 5.5. Hiệu năng
- Mỗi branch có **materialized view "head state"** (tập entity/relation hiện hành) được cập
  nhật khi commit, để traverse/blast-radius/đọc không phải fold lại từ đầu mỗi lần.

### 5.6. Nhập dữ liệu POC (importer — trong phạm vi v1, lựa chọn của tôi)
- Có **một importer** đưa dữ liệu mẫu nhúng trong `index.html` của POC (documents[] + relations[])
  vào **commit đầu tiên của branch `main`**. Đây vừa là seed cho demo E2E, vừa là fixture test.
- Ánh xạ: mỗi `document` → một entity (type/code/short_title/group/tier/title/metadata/
  content_markdown/flow/links); mỗi `relation` → một relation (source/target/kind/label).
- **Design-patterns catalog (`designPatterns[]`) — lựa chọn của tôi:** 5 pattern đã là node DP
  trong knowledge graph của POC thì nhập **như entity type `dp`** (giữ `flow_json`). Trang
  "Design Patterns" đứng riêng trong POC: v1 **chưa** dựng lại như một mục độc lập ngoài graph;
  giữ ở future-work để không phình phạm vi v1. Các pattern đã là node graph vẫn vào mô hình.

---

## 6. Branch / Diff / Merge

- **Tạo candidate**: tạo branch mới trỏ tới `parent_commit_id` = head của `main` tại thời điểm
  đó. Sửa trên candidate sinh các commit riêng, không chạm `main`.
- **Diff(baseline, candidate)**: fold cả hai tới head, so sánh theo `entity_id`/`relation_id`
  → danh sách `added / updated / deleted` cho entity và relation. Đây là dữ liệu cho UI "so
  sánh" và cho blast-radius của tập thay đổi.
- **Merge candidate → main**:
  - v1 dùng **three-way diff** với tổ tiên chung (commit mà candidate phân nhánh).
  - **Độ hạt xung đột — lựa chọn của tôi: entity-level / relation-level (cả bản ghi), KHÔNG
    field-level.** Nếu cùng một `entity_id` bị sửa ở cả hai bên (dù khác trường) → coi là một
    xung đột, người chọn bản của bên nào thắng. Field-level merge (gộp title bên A + markdown
    bên B) là nhiều code/test hơn hẳn, để dành cho bản sau.
  - **Xung đột tham chiếu (lựa chọn của tôi):** nếu `main` xoá một entity mà candidate thêm/sửa
    relation trỏ tới (hoặc ngược lại), đây là một **lớp xung đột riêng "referential"** — v1 báo
    cho người dùng và yêu cầu chọn: giữ entity (huỷ xoá) hay bỏ relation. Không bao giờ tạo
    relation mồ côi.
  - Không xung đột → tạo commit merge trên `main`.
  - Có xung đột → trả danh sách xung đột (gồm cả loại referential) cho UI; **v1 giải quyết thủ
    công** từng mục. Auto-merge thông minh hơn là việc sau.

---

## 7. Blast Radius

- Định nghĩa v1: với một node nguồn S và một hướng (downstream = những ai *phụ thuộc vào* S,
  upstream = những gì S phụ thuộc), blast radius là tập node đạt tới được bằng cách lần theo
  edge theo hướng đó, kèm **khoảng cách (số bậc)**.
- Tính bằng **recursive CTE** trên head-state của branch (duyệt đồ thị có hướng, chặn chu
  trình bằng tập đã thăm, có thể giới hạn độ sâu).
- Hai chế độ dùng:
  1. **Theo node**: chọn một node → xem nó ảnh hưởng/bị ảnh hưởng tới đâu.
  2. **Theo tập thay đổi của candidate**: lấy các `entity_id` trong diff làm nguồn → blast
     radius của toàn bộ thay đổi (archflow gọi là tác động của một candidate).
     - **Graph nào để duyệt (lựa chọn của tôi):** một thay đổi kiểu **xoá/sửa** được duyệt trên
       **head-state của baseline** (tác động của việc mất/đổi thứ đang tồn tại); một thay đổi
       kiểu **thêm** được duyệt trên **head-state của candidate** (component mới nối vào ai).
       Kết quả gộp lại, mỗi node trong blast radius ghi rõ do thay đổi nào gây ra. Lý do: tác
       động của việc xoá chỉ tồn tại ở đồ thị cũ, tác động của việc thêm chỉ tồn tại ở đồ thị
       mới — duyệt sai đồ thị cho ra kết quả nghe hợp lý nhưng sai.
- Kết quả trả về danh sách node + bậc + đường đi (để UI tô sáng trên three.js, tái dùng cơ chế
  highlight edge liền kề đã có trong POC).
- Ghi chú phạm vi: v1 là blast-radius **theo khả năng đạt tới (reachability)**; các "complexity
  lens / coupling analysis" định lượng của archflow là việc sau.

---

## 8. Lớp RAG (LLM mức 1)

- **Index**: khi commit, cập nhật `doc_chunk` cho các entity version có `content_markdown` đổi
  (chia chunk + embedding qua LLM adapter).
  - **Khoá theo `(entity_id, commit_id)` và dùng chung giữa các branch (lựa chọn của tôi):**
    chunk/embedding gắn với version của nội dung, nên nhiều branch cùng trỏ tới một version
    chia sẻ cùng embedding, không nhúng lại trùng lặp. Query của một branch lọc chunk theo tập
    version hiện hành (head-state) của branch đó.
  - **Index chạy nền, commit KHÔNG chặn trên embedding (lựa chọn của tôi):** commit ghi dữ liệu
    mô hình xong là trả về ngay; một **worker nền** sinh embedding cho các version mới. Lý do:
    gọi embedding (có thể là API ngoài) không được làm chậm/đổ vỡ thao tác sửa mô hình. Hệ quả
    kiến trúc: compose stack có thêm một tiến trình worker + một hàng đợi công việc đơn giản
    (bảng `embedding_job` trong Postgres là đủ cho v1, không cần message broker riêng).
- **Truy vấn**: câu hỏi → embedding → top-k chunk của branch đang xem (pgvector) → prompt LLM
  với các chunk làm ngữ cảnh → trả lời **kèm danh sách nguồn** (entity_id + code + short_title).
- **Adapter LLM**: interface `embed(texts)` + `complete(prompt, context)`; **v1 triển khai
  bằng Ollama local** (không cần mạng/khóa API), đọc endpoint/model từ biến môi trường;
  interface để sau cắm API ngoài / on-prem / tool-calling.
- **Số chiều embedding**: **chốt N = 768** (`nomic-embed-text` của Ollama) trong migration
  (`doc_chunk.embedding vector(768)`). Đổi model embedding sau = đổi chiều → cần reindex; v1
  coi provider embedding là cố định.
- Không agentic ở v1: LLM không gọi tool đồ thị, không sửa mô hình.

---

## 9. Kiến trúc dịch vụ

```
apps/
  web/   Vite + React + TS  (three.js graph, react-flow, markdown viewer, editor, workbench)
  api/   NestJS + TS        (model, versioning, branch/diff/merge, blast-radius, rag)
packages/
  shared/  type dùng chung (Entity, Relation, Branch, Commit, Diff, BlastRadius DTO)
infra/
  docker-compose.yml  (web, api, postgres+pgvector, ollama, worker)
```

Module API (NestJS): `model` (CRUD entity/relation trên một branch), `versioning`
(branch/commit/diff/merge), `analysis` (blast-radius), `rag` (index + query), `llm` (adapter,
triển khai Ollama). Một **worker nền** xử lý `embedding_job` (sinh embedding ngoài commit path).

### Lộ trình (theo hướng lõi-trước)
1. **Nền versioned-graph**: schema + fold + head materialized view + CRUD trên branch + commit.
2. **Branch/diff/merge**: tạo candidate, diff, merge three-way (xung đột thủ công).
3. **Blast radius**: recursive CTE, hai chế độ (theo node / theo tập thay đổi).
4. **RAG**: pgvector, index khi commit, query có trích dẫn, adapter LLM.
5. **Migrate POC FE**: three.js + react-flow + markdown lên Vite/React, nối API; đưa lại
   2D/3D, filter, đồng bộ hai chiều, collapse; thêm editor + workbench (diff/blast-radius UI).
6. **Docker Compose** gói toàn bộ chạy local.

> Mỗi bước có kiểm thử riêng (xem §11). Bước 1–4 là backend thuần, có thể verify không cần UI —
> phù hợp với lựa chọn "lõi-trước".

---

## 10. Những gì để lại cho builder quyết

- Chi tiết tên cột/ràng buộc Postgres, chỉ mục, kiểu `metadata_json`/`flow_json` (jsonb).
- Thư viện cụ thể: ORM/query builder (ví dụ Prisma/Drizzle/knex), client pgvector, thư viện
  test — chọn cái hợp NestJS, ghi lý do khi chọn.
- Chiến lược chunk tài liệu cho RAG (kích thước/overlap) — mặc định hợp lý, tinh chỉnh sau.
- Cách biểu diễn "op delete" khi fold (tombstone) ở mức truy vấn.
- Cấu trúc thư mục chi tiết trong `apps/web` khi migrate POC (tách component ra sao).

---

## 11. Verification

- **Backend (bước 1–4)**: unit + integration test trên Postgres thật (testcontainers hoặc
  compose test): fold trạng thái branch, diff đúng added/updated/deleted, merge không
  xung đột + phát hiện xung đột, blast-radius đúng tập/bậc trên đồ thị mẫu, RAG trả trích dẫn
  đúng entity. Dữ liệu mẫu CorpDigi từ POC dùng làm fixture.
- **Frontend (bước 5)**: render graph từ API, đồng bộ hai chiều, 2D/3D, filter, workbench hiển
  thị diff + tô sáng blast-radius; không lỗi console.
- **E2E (bước 6)**: qua Docker Compose — dựng node → tạo candidate → sửa → xem blast-radius →
  merge → hỏi RAG có trích dẫn.
- Chạy build/test của từng app trước khi coi một bước là xong (theo nguyên tắc verify).

---

## 12. Mở đường cho tương lai (ngoài v1)

- Multi-user + auth + quyền trên branch (schema đã chừa `author`/ownership).
- LLM agentic: tool-calling trên đồ thị (Explore có dẫn đường bằng chứng), rồi LLM soạn thay
  đổi mô hình trên candidate để người review (Full edit của archflow).
- Connectors hút dữ liệu từ repo/OpenAPI/Confluence (hướng C lai).
- Story mode, published minisite/handbook, complexity/coupling lens định lượng.
- Render draw.io/.docx native.
