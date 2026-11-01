# UI tweaks + pattern react-flow examples — Short Design

> Đợt nhỏ: 3 điều chỉnh UI + thêm sơ đồ react-flow "sinh động" cho một số design pattern.
> Trạng thái: bản thảo chờ duyệt. Ngày: 2026-11-01. Base: main (platform + extension đã merge).

## 1. Intent & Why
Ba yêu cầu điều chỉnh từ người dùng, sau khi chạy thử platform:
1. **Nút back điều hướng** — các trang (graph workspace, pattern wiki/detail, upload) cần nút
   quay-lại nhất quán để di chuyển dễ hơn.
2. **Design pattern thêm ví dụ react-flow** — PatternDetail hiện chỉ render Mermaid khái niệm;
   thêm một sơ đồ **react-flow** (node/edge có style, kéo-zoom được) cho một số pattern để sinh
   động hơn. (Hướng A đã chốt: lưu flow vào catalog, không hardcode FE.)
3. **Trang chủ thêm section link tới Design Patterns** — ProjectsHome hiện chỉ có nav-link nhỏ
   "Pattern Wiki" ở header; thêm một section rõ ràng trên trang chủ dẫn tới `/patterns`.

## 2. Goals / Non-Goals
### Goals
- Nút back nhất quán: mỗi trang không phải trang chủ có một nút điều hướng trở lại cấp trên hợp lý
  (graph `/projects/:id` → "← Projects" về `/`; PatternDetail đã có "All patterns"; PatternWiki có
  "← Projects"; UploadPage đã có "← Back to graph"). Bổ sung/nhất quán hoá, dùng chung class.
- `patterns` catalog thêm field **`flow`** (react-flow json, nullable); seed flow cho vài pattern
  hợp sơ đồ luồng (vd cqrs, saga, outbox, circuit-breaker, api-gateway — nhóm system-design).
- PatternDetail render **react-flow** (tái dùng FlowDiagram component) khi pattern có `flow`, bên
  cạnh Mermaid khái niệm (cả hai cùng hiện nếu có). GoF patterns có thể chỉ có Mermaid (class
  diagram) — không bắt buộc flow.
- ProjectsHome thêm một **section** (không chỉ nav-link) giới thiệu + link tới Pattern Wiki.

### Non-Goals
- Không làm pattern flow versioned (catalog vẫn plain CRUD, như mermaid hiện tại).
- Không sửa react-flow render engine (tái dùng FlowDiagram read-only y nguyên).
- Không đổi used-by / appliesPatterns / project isolation.
- Không thêm editor cho pattern flow (flow đến từ seed; CRUD API nhận flow nhưng FE không soạn).

## 3. Constraints / Approaches
- Stack theo hiện tại: NestJS + Drizzle + Postgres; Vite+React+react-router; reactflow@11.
- **(A) đã chọn:** flow lưu trong `patterns.flow_json` (jsonb, nullable), seed trong
  patterns-seed.json; API trả `flow` trong Pattern; FE render qua FlowDiagram (component read-only
  đã có ở viewer/FlowDiagram.tsx — nó nhận `flow: unknown`, validate `{nodes,edges}`). Không hardcode.
- `patterns.kind` hiện là string tự do (creational/structural/behavioral cho GoF) — KHÔNG trùng
  `DiagramSpec.kind`. Field flow mới độc lập với `kind`. Mermaid `kind` map ('sequence'→sequence,
  else system) giữ nguyên ở PatternDetail cho phần Mermaid.

## 4. Mô hình dữ liệu
- `patterns` thêm cột `flow_json jsonb` (nullable), migration 0007 (ADD COLUMN, non-breaking).
- shared/API: `Pattern` thêm `flow?: unknown | null`; CreatePatternDto/UpdatePatternDto thêm
  `flow?` (optional); pattern.service toPattern/create/update/seedPatterns map `flowJson`.
- patterns-seed.json: thêm `flow` (react-flow {nodes,edges} với style) cho ~5 system-design pattern
  (cqrs/saga/outbox/circuit-breaker/api-gateway). Node dùng style màu nhẹ cho sinh động. (Dữ liệu —
  builder chọn sơ đồ hợp lý mỗi pattern.)
  - Lưu ý seed idempotent ON CONFLICT (slug) DO NOTHING: pattern đã seed trước sẽ KHÔNG được cập
    nhật flow khi chỉ thêm field. → migration 0007 phải backfill flow cho các slug seed-sẵn (UPDATE
    patterns SET flow_json=... WHERE slug=...), HOẶC seedPatterns dùng upsert cập nhật flow. Builder
    chọn; mặc định: migration 0007 ADD COLUMN; và đổi seedPatterns sang onConflictDoUpdate CHỈ cho
    flow_json (giữ các field khác nguyên) để re-seed trên DB cũ cũng nạp flow. Ghi rõ lựa chọn.

## 5. UI
- `styles.css`: một class nút back dùng chung (tái dùng `.nav-link` + biến thể "← back").
- ProjectWorkspace/App graph header: thêm "← Projects" về `/`.
- PatternWiki header "← Projects" (đã có link Projects — chỉnh thành nút back rõ ràng).
- ProjectsHome: section mới "Design Patterns" (mô tả ngắn + nút/link lớn tới `/patterns`), ngoài
  nav-link header.
- PatternDetail: nếu `pattern.flow` hợp lệ → render `<FlowDiagram flow={pattern.flow} />` trong một
  section "Example flow" (cạnh Concept diagram Mermaid). FlowDiagram đã validate shape, render rỗng
  nếu không hợp lệ — an toàn.

## 6. Verification
- API: pattern.service test — flow round-trips qua create/get/seed; migration 0007 adds flow_json;
  một seeded pattern (vd cqrs) có flow sau bootstrap (backfill/upsert hoạt động).
- FE: PatternDetail test — pattern có flow render FlowDiagram (mock), pattern không flow thì không;
  ProjectsHome test — có section link `/patterns`; back-button test (graph header có link về `/`).
- Build + full suite xanh; no regression (api ~139, web ~70). Sau đó rebuild stack + mở web xác nhận.

## 7. Để builder quyết
- Backfill flow cho seed cũ: migration UPDATE vs seedPatterns onConflictDoUpdate(flow_json). Mặc
  định: seedPatterns upsert flow_json only. Ghi rõ.
- Sơ đồ react-flow cụ thể mỗi pattern (nodes/edges/style) — dữ liệu, chọn hợp lý.
- Chính xác pattern nào có flow (mặc định 5 system-design; GoF giữ Mermaid class diagram).
