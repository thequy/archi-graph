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
//
// Exit code 0 = all steps passed; non-zero = a step failed (details on stderr).

const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const ASK_POLL_TIMEOUT_MS = Number(process.env.ASK_POLL_TIMEOUT_MS ?? 240_000);
const ASK_POLL_INTERVAL_MS = Number(process.env.ASK_POLL_INTERVAL_MS ?? 5_000);

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

async function main() {
  console.log(`e2e-smoke against ${API_URL}`);

  // ── 1. Health ──────────────────────────────────────────────────────────
  const health = await req('GET', '/health');
  if (!health.ok || !health.json || health.json.status !== 'ok') {
    fail('GET /health did not return ok', health.text);
  }
  pass('GET /health -> ok');

  // ── 2. Seed present on main ──────────────────────────────────────────────
  const branches = await req('GET', '/branches');
  if (!branches.ok || !Array.isArray(branches.json)) {
    fail('GET /branches did not return a list', branches.text);
  }
  const mainBranch = branches.json.find((b) => b.name === 'main');
  if (!mainBranch) fail('no branch named "main" found', branches.json);
  const mainId = mainBranch.id;
  pass(`main branch resolved (id=${mainId})`);

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

  console.log('\nALL SMOKE STEPS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
