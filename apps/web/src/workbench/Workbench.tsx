// Workbench — branch/candidate operations panel.
//
// Flow (the "candidate → diff → blast → merge → resolve" loop):
//   1. Branch picker: lists branches (api.listBranches); the user picks a
//      CANDIDATE to compare against the base branch. A candidate can also be
//      created on the fly (api.createCandidate).
//   2. Diff: api.getDiff(base, candidate) -> GraphDiff. We tally added/updated/
//      deleted across entities + relations and list the changed ids.
//   3. Blast: api.blastForCandidate(base, candidate, 'downstream') -> BlastRadius.
//      Downstream = DEPENDENTS (who depends on the changed nodes). We lift the
//      resulting entity-id set to the host via onHighlightBlast so Graph3D can
//      highlight it (reusing/extending the graph's highlight mechanism).
//   4. Merge: api.merge(candidate, resolutions?) -> MergeResult. A clean result
//      shows the new commit id. A conflict result lists each MergeConflict and
//      lets the user choose a resolution per id ('ours'|'theirs'|'base'); the
//      retry replays { id: resolution } back through api.merge.

import { useEffect, useMemo, useState } from 'react';
import type { BlastRadius, GraphDiff } from '@archi-graph/shared';
import { api, type BranchSummary, type MergeConflict, type MergeResolutions } from '../api/client';

export interface WorkbenchProps {
  /** The base branch the candidate is compared against / merged into. */
  baseBranchId: string;
  /** Lift the blast-radius entity-id set so the host can highlight the graph. */
  onHighlightBlast: (entityIds: string[]) => void;
  /** Notify the host when the active branch should change (e.g. after merge). */
  onBranchChange: (branchId: string) => void;
}

interface DiffCounts {
  added: number;
  updated: number;
  deleted: number;
}

function tally(diff: GraphDiff): DiffCounts {
  const counts: DiffCounts = { added: 0, updated: 0, deleted: 0 };
  for (const items of [diff.entities, diff.relations]) {
    for (const it of items) counts[it.kind] += 1;
  }
  return counts;
}

export function Workbench({
  baseBranchId,
  onHighlightBlast,
  onBranchChange,
}: WorkbenchProps): JSX.Element {
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [candidateId, setCandidateId] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [diff, setDiff] = useState<GraphDiff | null>(null);
  const [blast, setBlast] = useState<BlastRadius | null>(null);
  const [conflicts, setConflicts] = useState<MergeConflict[] | null>(null);
  const [resolutions, setResolutions] = useState<MergeResolutions>({});
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listBranches()
      .then((bs) => {
        if (cancelled) return;
        setBranches(bs);
        // Default the candidate to the first branch that isn't the base.
        const firstOther = bs.find((b) => b.id !== baseBranchId);
        if (firstOther) setCandidateId((cur) => cur || firstOther.id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [baseBranchId]);

  const counts = useMemo(() => (diff ? tally(diff) : null), [diff]);

  async function run<T>(fn: () => Promise<T>, after: (v: T) => void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      after(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCreateCandidate(): void {
    if (!newName.trim()) return;
    void run(
      () => api.createCandidate(newName.trim(), baseBranchId),
      (res) => {
        setNewName('');
        setCandidateId(res.branchId);
        void api.listBranches().then(setBranches).catch(() => {});
      },
    );
  }

  function onDiff(): void {
    if (!candidateId) return;
    void run(
      () => api.getDiff(baseBranchId, candidateId),
      (d) => setDiff(d),
    );
  }

  function onBlast(): void {
    if (!candidateId) return;
    void run(
      () => api.blastForCandidate(baseBranchId, candidateId, 'downstream'),
      (b) => {
        setBlast(b);
        onHighlightBlast(b.nodes.map((n) => n.entityId));
      },
    );
  }

  function applyMergeResult(res: Awaited<ReturnType<typeof api.merge>>): void {
    if (res.status === 'clean') {
      setConflicts(null);
      setResolutions({});
      setMergeMsg(`Merged cleanly — commit ${res.commitId}`);
      onBranchChange(baseBranchId);
    } else {
      setMergeMsg(null);
      setConflicts(res.conflicts);
    }
  }

  function onMerge(): void {
    if (!candidateId) return;
    void run(() => api.merge(candidateId, undefined), applyMergeResult);
  }

  function onResolve(): void {
    if (!candidateId) return;
    void run(() => api.merge(candidateId, resolutions), applyMergeResult);
  }

  return (
    <section className="workbench" aria-label="Workbench">
      <div className="wb-section">
        <h3>Branches</h3>
        <div className="wb-row">
          <label htmlFor="wb-candidate">Candidate</label>
          <select
            id="wb-candidate"
            value={candidateId}
            onChange={(e) => setCandidateId(e.target.value)}
          >
            <option value="">— select —</option>
            {branches
              .filter((b) => b.id !== baseBranchId)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </div>
        <div className="wb-row">
          <input
            aria-label="New candidate name"
            placeholder="New candidate name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="button" onClick={onCreateCandidate} disabled={busy || !newName.trim()}>
            Create candidate
          </button>
        </div>
      </div>

      <div className="wb-section">
        <h3>Changes</h3>
        <div className="wb-actions">
          <button type="button" onClick={onDiff} disabled={busy || !candidateId}>
            Diff
          </button>
          <button type="button" onClick={onBlast} disabled={busy || !candidateId}>
            Blast radius
          </button>
          <button type="button" onClick={onMerge} disabled={busy || !candidateId}>
            Merge
          </button>
        </div>

        {counts && (
          <div className="wb-diff-counts">
            <span className="dc added">
              Added <b data-testid="diff-added">{counts.added}</b>
            </span>
            <span className="dc updated">
              Updated <b data-testid="diff-updated">{counts.updated}</b>
            </span>
            <span className="dc deleted">
              Deleted <b data-testid="diff-deleted">{counts.deleted}</b>
            </span>
          </div>
        )}

        {diff && (
          <ul className="wb-diff-list">
            {[...diff.entities, ...diff.relations].map((it) => (
              <li key={`${it.kind}:${it.id}`} className={`di ${it.kind}`}>
                <span className="di-kind">{it.kind}</span>
                <span className="di-id">{it.id}</span>
              </li>
            ))}
          </ul>
        )}

        {blast && (
          <div className="wb-blast" data-testid="wb-blast">
            Blast radius ({blast.direction}): {blast.nodes.length} node(s)
          </div>
        )}
      </div>

      {mergeMsg && <div className="wb-merge-ok">{mergeMsg}</div>}

      {conflicts && conflicts.length > 0 && (
        <div className="wb-section wb-conflicts">
          <h3>Merge conflicts</h3>
          <ul>
            {conflicts.map((c) => (
              <li key={c.id} className="wb-conflict">
                <span className="wc-kind">{c.kind}</span>
                <span className="wc-id">{c.id}</span>
                <label>
                  <select
                    aria-label={`Resolve ${c.id}`}
                    value={(resolutions[c.id] as string) ?? ''}
                    onChange={(e) =>
                      setResolutions((r) => ({
                        ...r,
                        [c.id]: e.target.value as 'ours' | 'theirs' | 'base',
                      }))
                    }
                  >
                    <option value="">— choose —</option>
                    <option value="ours">ours</option>
                    <option value="theirs">theirs</option>
                    <option value="base">base</option>
                  </select>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onResolve} disabled={busy}>
            Resolve &amp; retry merge
          </button>
        </div>
      )}

      {error && <div className="wb-error">{error}</div>}
    </section>
  );
}
