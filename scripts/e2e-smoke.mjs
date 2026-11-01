#!/usr/bin/env node
// End-to-end smoke test against the running Archi-Graph stack (compose).
//
// Exercises the whole platform through the live HTTP API:
//   1. GET  /health                          -> ok
//   2. GET  /branches  (resolve main's id)   -> main branch present
//      GET  /branches/<main>/graph           -> seeded CorpDigi entities (>40)
//   3. POST /branches  (create candidate off main)
//      DELETE one entity on the candidate
//      GET  /diff?base=<main>&candidate=<cand> -> exactly 1 deleted entity
//      GET  /blast/candidate?base=&candidate=  -> >=1 affected node
//      POST /branches/<cand>/merge             -> status 'clean'
//   4. POST /branches/<main>/ask              -> answer with >=1 citation
//      (polled: the worker must have embedded the seed first)
//   5. GET  /projects                          -> demo 'CorpDigi' project present
//      POST /projects                          -> create a SECOND project
//   6. Upload isolation (LIVE, multi-project):
//      POST /projects/<p2>/files (multipart .md) -> { fileId, summaryStatus }
//      poll GET /files/<id> until summaryStatus 'done' (worker extracts +
//        summarizes via the gen model + commits an entity + embeds it)
//      resolve p2's main; POST /branches/<p2 main>/ask -> cites the upload's
//        entity (code DOC-… / entityId upload-…)
//      POST /branches/<demo main>/ask (same question) -> does NOT cite the
//        upload (cross-project RAG isolation, proven live)
//   7. Patterns:
//      GET /patterns                           -> catalog includes 'singleton'
//      POST /branches/<demo main>/entities { appliesPatterns:['cqrs'], ... }
//      GET /patterns/cqrs/used-by              -> includes that entity
//
// NOTE on "main": the API addresses branches by their UUID id, and `main` is a
// branch *name*, not an id. So "GET /branches/main/graph" in the task brief is
// shorthand for "the main branch's graph" — we resolve main's real id from
// GET /branches first, then use it everywhere.
//
// Config via env:
//   API_URL           default http://localhost:3001
//   ASK_POLL_TIMEOUT_MS   how long to wait for the worker to index (default 240000)
//   ASK_POLL_INTERVAL_MS  poll cadence for the ask step (default 5000)
//   INGEST_POLL_TIMEOUT_MS  how long to wait for the worker to summarize an
//                           upload (extract + LLM summary + embed) — default 300000
//   DEMO_PROJECT_ID   the stable CorpDigi demo project id (default below)
//
// Exit code 0 = all steps passed; non-zero = a step failed (details on stderr).

const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const ASK_POLL_TIMEOUT_MS = Number(process.env.ASK_POLL_TIMEOUT_MS ?? 240_000);
const ASK_POLL_INTERVAL_MS = Number(process.env.ASK_POLL_INTERVAL_MS ?? 5_000);
const INGEST_POLL_TIMEOUT_MS = Number(
  process.env.INGEST_POLL_TIMEOUT_MS ?? 300_000,
);
// The stable id migration 0001 assigns the demo 'CorpDigi' project.
const DEMO_PROJECT_ID =
  process.env.DEMO_PROJECT_ID ?? '11111111-1111-1111-1111-111111111111';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 0;
function pass(msg) {
  step += 1;
  console.log(`  \u2713 [${step}] ${msg}`);
}
function fail(msg, detail) {
  console.error(`  \u2717 ${msg}`);
  if (detail !== undefined) console.error('    detail:', detail);
  process.exit(1);
}

async function req(method, path, body) {
  const url = `${API_URL}${path}`;
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    fail(`${method} ${path} — request failed (is the stack up?)`, String(err));
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text };
}

/**
 * Resolves a project's `main` branch id via GET /branches?projectId=<id>.
 * Fails loud if the project has no main (every project gets one on creation).
 */
async function resolveProjectMain(projectId, label) {
  const res = await req('GET', `/branches?projectId=${projectId}`);
  if (!res.ok || !Array.isArray(res.json)) {
    fail(`GET /branches?projectId=${projectId} did not return a list`, res.text);
  }
  const main = res.json.find((b) => b.name === 'main');
  if (!main) fail(`no 'main' branch for ${label} project ${projectId}`, res.json);
  return main.id;
}

/** Single RAG ask; returns the parsed answer (or undefined on a non-2xx). */
async function askOnce(branchId, question) {
  const ask = await req('POST', `/branches/${branchId}/ask`, { question });
  return ask.ok && ask.json ? ask.json : undefined;
}

/** True iff the answer cites an entity whose entityId equals `entityId`. */
function citesEntity(answer, entityId) {
  return (
    !!answer &&
    Array.isArray(answer.citations) &&
    answer.citations.some((c) => c.entityId === entityId)
  );
}

async function main() {
  console.log(`e2e-smoke against ${API_URL}`);

  // ── 1. Health ──────────────────────────────────────────────────────────
  const health = await req('GET', '/health');
  if (!health.ok || !health.json || health.json.status !== 'ok') {
    fail('GET /health did not return ok', health.text);
  }
  pass('GET /health -> ok');

  // ── 2. Seed present on the DEMO project's main ───────────────────────────
  // Resolve the demo (CorpDigi) project's main by projectId so the listing is
  // unambiguous even after a 2nd project (and its own main) exists.
  const mainId = await resolveProjectMain(DEMO_PROJECT_ID, 'demo (CorpDigi)');
  pass(`demo project main branch resolved (id=${mainId})`);

  const graph = await req('GET', `/branches/${mainId}/graph`);
  if (!graph.ok || !graph.json || !Array.isArray(graph.json.entities)) {
    fail('GET /branches/<main>/graph did not return a head-state', graph.text);
  }
  const entityCount = graph.json.entities.length;
  if (entityCount <= 40) {
    fail(`expected >40 seeded entities on main, got ${entityCount}`);
  }
  pass(`main graph has ${entityCount} entities (>40)`);

  // ── 3. candidate -> delete -> diff -> blast -> merge ──────────────────────
  const candName = `smoke-candidate-${Date.now()}`;
  const created = await req('POST', '/branches', {
    name: candName,
    fromBranchId: mainId,
  });
  if (!created.ok || !created.json || !created.json.branchId) {
    fail('POST /branches (create candidate) failed', created.text);
  }
  const candId = created.json.branchId;
  pass(`created candidate branch (id=${candId})`);

  // Two independent mutations on the candidate, each chosen so the final merge
  // stays CLEAN (no dangling relation / referential conflict):
  //   (a) DELETE an ISOLATED entity (no relations touch it) — a connected
  //       delete would orphan its relations on merge (referential conflict).
  //   (b) UPDATE a CONNECTED entity that is a relation TARGET — this gives the
  //       candidate change-set a non-empty downstream blast radius (the target's
  //       dependents), while an update (unlike a delete) never orphans a
  //       relation, so merge remains clean.
  const relations = graph.json.relations ?? [];
  const endpointIds = new Set();
  const targetIds = new Set();
  for (const r of relations) {
    endpointIds.add(r.sourceEntityId);
    endpointIds.add(r.targetEntityId);
    targetIds.add(r.targetEntityId);
  }

  const isolated = graph.json.entities.find((e) => !endpointIds.has(e.entityId));
  if (!isolated) fail('no isolated entity available to delete for a clean merge');
  const deleteTargetId = isolated.entityId;

  const connected = graph.json.entities.find((e) => targetIds.has(e.entityId));
  if (!connected) fail('no connected (relation-target) entity available to update');
  const updateTargetId = connected.entityId;

  // (a) delete the isolated entity.
  const del = await req(
    'DELETE',
    `/branches/${candId}/entities/${deleteTargetId}`,
  );
  if (!del.ok) fail('DELETE entity on candidate failed', del.text);
  pass(`deleted isolated entity ${deleteTargetId} on candidate`);

  // (b) update the connected entity (re-POST with a changed title).
  const upd = await req('POST', `/branches/${candId}/entities`, {
    ...connected,
    title: `${connected.title} [smoke-edit]`,
  });
  if (!upd.ok) fail('UPDATE (re-POST) connected entity on candidate failed', upd.text);
  pass(`updated connected entity ${updateTargetId} on candidate`);

  // diff(base=main, candidate) — the deleted entity is present on main (base),
  // absent on candidate => exactly one 'deleted' entity.
  const diff = await req(
    'GET',
    `/diff?base=${mainId}&candidate=${candId}`,
  );
  if (!diff.ok || !diff.json || !Array.isArray(diff.json.entities)) {
    fail('GET /diff did not return a GraphDiff', diff.text);
  }
  const deleted = diff.json.entities.filter((d) => d.kind === 'deleted');
  if (deleted.length !== 1 || deleted[0].id !== deleteTargetId) {
    fail(
      `expected exactly 1 deleted entity (${deleteTargetId}), got ${deleted.length}`,
      diff.json.entities,
    );
  }
  pass('GET /diff shows exactly 1 deleted entity');

  // blast/candidate — the candidate change-set's affected nodes.
  const blast = await req(
    'GET',
    `/blast/candidate?base=${mainId}&candidate=${candId}`,
  );
  if (!blast.ok || !blast.json || !Array.isArray(blast.json.nodes)) {
    fail('GET /blast/candidate did not return a BlastRadius', blast.text);
  }
  if (blast.json.nodes.length < 1) {
    fail('expected >=1 affected node from blast/candidate', blast.json);
  }
  pass(`GET /blast/candidate returned ${blast.json.nodes.length} affected node(s)`);

  // merge candidate back into main -> clean.
  const merge = await req('POST', `/branches/${candId}/merge`, {});
  if (!merge.ok || !merge.json) fail('POST merge failed', merge.text);
  if (merge.json.status !== 'clean') {
    fail(`expected merge status 'clean', got '${merge.json.status}'`, merge.json);
  }
  pass("POST /branches/<cand>/merge -> 'clean'");

  // ── 4. ask with >=1 citation (poll until the worker has indexed) ──────────
  const question =
    'What does the CorpDigi corporate digital banking platform do?';
  const deadline = Date.now() + ASK_POLL_TIMEOUT_MS;
  let lastAnswer;
  let got = false;
  while (Date.now() < deadline) {
    const ask = await req('POST', `/branches/${mainId}/ask`, { question });
    if (ask.ok && ask.json) {
      lastAnswer = ask.json;
      if (Array.isArray(ask.json.citations) && ask.json.citations.length >= 1) {
        got = true;
        break;
      }
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    console.log(
      `    ...ask returned ${
        lastAnswer ? lastAnswer.citations?.length ?? 0 : 0
      } citation(s); waiting for worker to index (~${remaining}s left)`,
    );
    await sleep(ASK_POLL_INTERVAL_MS);
  }
  if (!got) {
    fail(
      'POST /ask never returned an answer with >=1 citation within the poll window',
      lastAnswer,
    );
  }
  pass(
    `POST /branches/<main>/ask -> answer with ${lastAnswer.citations.length} citation(s)`,
  );

  // ── 5. Projects: demo present + create a 2nd project ─────────────────────
  const projects = await req('GET', '/projects');
  if (!projects.ok || !Array.isArray(projects.json)) {
    fail('GET /projects did not return a list', projects.text);
  }
  const demo = projects.json.find((p) => p.id === DEMO_PROJECT_ID);
  if (!demo) fail('demo CorpDigi project not present in GET /projects', projects.json);
  if (demo.name !== 'CorpDigi') {
    fail(`demo project name expected 'CorpDigi', got '${demo.name}'`, demo);
  }
  pass(`GET /projects includes demo 'CorpDigi' (id=${demo.id})`);

  const p2Name = `smoke-project-${Date.now()}`;
  const p2Created = await req('POST', '/projects', {
    name: p2Name,
    description: 'Second project created by the e2e smoke.',
  });
  if (!p2Created.ok || !p2Created.json || !p2Created.json.id) {
    fail('POST /projects (create 2nd project) failed', p2Created.text);
  }
  const p2Id = p2Created.json.id;
  pass(`created 2nd project '${p2Name}' (id=${p2Id})`);

  // Each project gets its own main on creation (ProjectService -> ensureProjectMain).
  const p2MainId = await resolveProjectMain(p2Id, '2nd');
  pass(`2nd project main branch resolved (id=${p2MainId})`);

  // ── 6. Upload isolation (live): upload a .md to p2, wait for summary, RAG ──
  // A distinctive, invented fact so the RAG answer provably comes from THIS
  // upload (not from the demo seed). The question targets that fact.
  const magicToken = `ZORBLAX-${Date.now()}`;
  const uploadMd =
    `# Project Phoenix Field Notes\n\n` +
    `Project Phoenix is an internal initiative. Its codename beacon is ` +
    `${magicToken}. The beacon ${magicToken} identifies the Phoenix telemetry ` +
    `relay, a custom service unique to this uploaded document and found nowhere ` +
    `else in the knowledge base.\n`;
  const uploadQuestion =
    `What is the codename beacon of Project Phoenix and what does it identify?`;

  const form = new FormData();
  form.append(
    'file',
    new Blob([uploadMd], { type: 'text/markdown' }),
    'project-phoenix.md',
  );
  let uploadRes;
  try {
    uploadRes = await fetch(`${API_URL}/projects/${p2Id}/files`, {
      method: 'POST',
      body: form,
    });
  } catch (err) {
    fail('POST /projects/<p2>/files (upload) request failed', String(err));
  }
  const uploadText = await uploadRes.text();
  let uploadJson;
  try {
    uploadJson = uploadText ? JSON.parse(uploadText) : undefined;
  } catch {
    uploadJson = undefined;
  }
  if (!uploadRes.ok || !uploadJson || !uploadJson.fileId) {
    fail('POST /projects/<p2>/files did not return a fileId', uploadText);
  }
  const fileId = uploadJson.fileId;
  pass(`uploaded .md to p2 (fileId=${fileId}, status=${uploadJson.summaryStatus})`);

  // Poll GET /files/<id> until the worker has extracted + summarized + the
  // ingest commit happened (summaryStatus 'done'); bail loud on 'failed'.
  const ingestDeadline = Date.now() + INGEST_POLL_TIMEOUT_MS;
  let fileMeta;
  let ingestDone = false;
  while (Date.now() < ingestDeadline) {
    const meta = await req('GET', `/files/${fileId}`);
    if (meta.ok && meta.json) {
      fileMeta = meta.json;
      if (fileMeta.summaryStatus === 'done') {
        ingestDone = true;
        break;
      }
      if (fileMeta.summaryStatus === 'failed') {
        fail('upload ingest reached summaryStatus=failed', fileMeta);
      }
    }
    const remaining = Math.round((ingestDeadline - Date.now()) / 1000);
    console.log(
      `    ...file summaryStatus=${
        fileMeta ? fileMeta.summaryStatus : '?'
      }; waiting for worker ingest (~${remaining}s left)`,
    );
    await sleep(ASK_POLL_INTERVAL_MS);
  }
  if (!ingestDone) {
    fail('upload never reached summaryStatus=done within the poll window', fileMeta);
  }
  if (!fileMeta.entityId) {
    fail('ingested file has no linked entityId', fileMeta);
  }
  const uploadedEntityId = fileMeta.entityId;
  pass(`upload ingested -> entity ${uploadedEntityId} (summaryStatus=done)`);

  // RAG on p2's main MUST cite the uploaded doc's entity. The entity was
  // enqueued for embedding by the ingest commit; poll until the indexer has
  // embedded it and the ask cites it.
  const p2AskDeadline = Date.now() + ASK_POLL_TIMEOUT_MS;
  let p2Answer;
  let p2Cited = false;
  while (Date.now() < p2AskDeadline) {
    p2Answer = await askOnce(p2MainId, uploadQuestion);
    if (citesEntity(p2Answer, uploadedEntityId)) {
      p2Cited = true;
      break;
    }
    const remaining = Math.round((p2AskDeadline - Date.now()) / 1000);
    console.log(
      `    ...p2 ask cited ${
        p2Answer ? p2Answer.citations?.length ?? 0 : 0
      } entity(ies), not yet the upload; waiting for embed (~${remaining}s left)`,
    );
    await sleep(ASK_POLL_INTERVAL_MS);
  }
  if (!p2Cited) {
    fail(
      `p2 RAG never cited the uploaded entity ${uploadedEntityId} within the poll window`,
      p2Answer,
    );
  }
  pass(`p2 RAG ask cites the uploaded doc entity ${uploadedEntityId}`);

  // Cross-project isolation: the SAME question on the DEMO project's main must
  // NOT cite the p2 upload (the upload lives only in p2's doc_chunks).
  const demoAnswer = await askOnce(mainId, uploadQuestion);
  if (citesEntity(demoAnswer, uploadedEntityId)) {
    fail(
      'cross-project isolation BROKEN: demo RAG cited the p2 upload entity',
      demoAnswer,
    );
  }
  pass('demo RAG does NOT cite the p2 upload entity (cross-project isolation)');

  // ── 7. Patterns: catalog seeded + appliesPatterns -> used-by ─────────────
  const patterns = await req('GET', '/patterns');
  if (!patterns.ok || !Array.isArray(patterns.json)) {
    fail('GET /patterns did not return a list', patterns.text);
  }
  if (!patterns.json.some((p) => p.slug === 'singleton')) {
    fail("GET /patterns does not include the seeded 'singleton' pattern", patterns.json);
  }
  pass(`GET /patterns includes 'singleton' (${patterns.json.length} patterns total)`);

  // Commit a NEW entity on the demo project's main that applies 'cqrs'. used-by
  // is main-branches-only, so committing on main (not a candidate) is required.
  const patternEntityId = `smoke-pattern-${Date.now()}`;
  const applied = await req('POST', `/branches/${mainId}/entities`, {
    entityId: patternEntityId,
    type: 'sad',
    code: `SMOKE-CQRS-${Date.now()}`,
    shortTitle: 'Smoke CQRS component',
    group: 'soe',
    tier: 't2',
    title: 'Smoke CQRS component',
    metadata: { author: 'smoke', date: new Date().toISOString().slice(0, 10), status: 'draft', tags: ['smoke'] },
    contentMarkdown: 'A component applying the CQRS pattern, created by the e2e smoke.',
    links: [],
    appliesPatterns: ['cqrs'],
  });
  if (!applied.ok || !applied.json || !applied.json.entityId) {
    fail('POST entity with appliesPatterns:[cqrs] on demo main failed', applied.text);
  }
  const appliedEntityId = applied.json.entityId;
  pass(`committed entity ${appliedEntityId} applying 'cqrs' on demo main`);

  const usedBy = await req('GET', '/patterns/cqrs/used-by');
  if (!usedBy.ok || !Array.isArray(usedBy.json)) {
    fail('GET /patterns/cqrs/used-by did not return a list', usedBy.text);
  }
  if (!usedBy.json.some((u) => u.entityId === appliedEntityId)) {
    fail(
      `GET /patterns/cqrs/used-by does not include the entity ${appliedEntityId}`,
      usedBy.json,
    );
  }
  pass(`GET /patterns/cqrs/used-by includes entity ${appliedEntityId}`);

  console.log('\nALL SMOKE STEPS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
