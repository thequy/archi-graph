// App shell — wires the full three-panel Archi-Graph UI on top of the Task 10
// primitives (api client + Graph3D).
//
// LAYOUT:
//   - LEFT   : the three.js graph (Graph3D) + group/type filter panel.
//   - RIGHT  : a tabbed side panel. Tabs:
//       • Document  — DocViewer (sanitized markdown + lazy reactflow) + the
//                     DetailPanel (metadata + relationships) for the selection.
//       • Editor    — EntityEditor (create/edit → api.createEntity).
//       • Workbench — branch picker, diff, blast-radius, merge + conflicts.
//       • Ask       — RAG question/answer with clickable citations.
//
// CENTRAL STATE (what the POC kept in a global `state`, now React state):
//   - branchId         : the active branch (graph is fetched for it).
//   - selectedEntityId : two-way synced with the graph (click node ↔ open doc),
//                        the detail panel (click relationship → navigate), and
//                        AskPanel (click citation → select source node).
//   - mode / filters   : 3D vs 2D, hidden groups/types.
//   - blastIds         : blast-radius entity-id set lifted from the Workbench to
//                        drive Graph3D's blast highlight.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Group, HeadState, EntityType } from '@archi-graph/shared';
import { GROUPS, ENTITY_TYPES } from '@archi-graph/shared';
import { api } from './api/client';
import { Graph3D, type GraphFilter } from './graph/Graph3D';
import type { LayoutMode } from './graph/layout';
import { GROUP_STYLES, TYPE_STYLES } from './graph/styles';
import { DocViewer } from './viewer/DocViewer';
import { DetailPanel } from './detail/DetailPanel';
import { EntityEditor } from './editor/EntityEditor';
import { Workbench } from './workbench/Workbench';
import { AskPanel } from './ask/AskPanel';

// The default branch is addressed by NAME in the UI/URL, but the API keys
// branches by UUID (branch_id is a uuid column). We must never send a name
// where a uuid is expected — doing so makes foldHeadState run
// `WHERE branch_id = 'main'` against a uuid column → Postgres 500. So on boot
// we resolve the 'main' branch's UUID from listBranches() BEFORE the first
// getGraph, and only load the graph once a real id is known.
const DEFAULT_BRANCH_NAME = 'main';

type Tab = 'document' | 'editor' | 'workbench' | 'ask';

export interface AppProps {
  /**
   * The project whose graph this App renders. Branch resolution is scoped to
   * this project: listBranches(projectId) → the branch named 'main' → its UUID
   * → getGraph(uuid). Supplied by the route (/projects/:projectId).
   */
  projectId: string;
}

export function App({ projectId }: AppProps): JSX.Element {
  // null until the bootstrap effect resolves main's UUID from listBranches.
  const [branchId, setBranchId] = useState<string | null>(null);
  const [head, setHead] = useState<HeadState>({ entities: [], relations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LayoutMode>('3d');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenGroups, setHiddenGroups] = useState<Set<Group>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<EntityType>>(new Set());
  const [blastIds, setBlastIds] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('document');
  const [reloadKey, setReloadKey] = useState(0);

  // Bootstrap: resolve THIS project's 'main' branch UUID from
  // listBranches(projectId) BEFORE any getGraph. Until branchId is a real UUID
  // we do NOT touch the graph endpoint (sending the name 'main' — or a
  // projectId — to a uuid column would 500). If no 'main' branch exists for the
  // project yet we leave branchId null and show an empty state — never a crash.
  // Re-runs when projectId changes (navigating between projects).
  useEffect(() => {
    let cancelled = false;
    setBranchId(null);
    setLoading(true);
    api
      .listBranches(projectId)
      .then((bs) => {
        if (cancelled) return;
        const main = bs.find((b) => b.name === DEFAULT_BRANCH_NAME);
        if (main) {
          setBranchId(main.id);
          setError(null);
        } else {
          // No main branch yet: empty state, graph load stays gated.
          setError(null);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const loadGraph = useCallback((branch: string) => {
    let cancelled = false;
    setLoading(true);
    api
      .getGraph(branch)
      .then((h) => {
        if (!cancelled) {
          setHead(h);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the graph only once a real branch UUID is resolved. The name→id
  // resolution above gates this so getGraph is never called with 'main'.
  useEffect(() => {
    if (branchId === null) return;
    return loadGraph(branchId);
  }, [branchId, reloadKey, loadGraph]);

  const filter: GraphFilter = useMemo(
    () => ({ hiddenGroups: [...hiddenGroups], hiddenTypes: [...hiddenTypes] }),
    [hiddenGroups, hiddenTypes],
  );

  const selected = useMemo(
    () => head.entities.find((e) => e.entityId === selectedId) ?? null,
    [head, selectedId],
  );

  // Selecting a node from anywhere (graph / detail / citation) opens its doc.
  const selectEntity = useCallback((id: string) => {
    setSelectedId(id);
    setTab('document');
  }, []);

  function toggle<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function refresh(): void {
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo" />
        <div>
          <h1>Archi-Graph</h1>
          <div className="sub">Architecture Knowledge Graph · {branchId ?? DEFAULT_BRANCH_NAME}</div>
        </div>
        <span className="spacer" />
        <Link to={`/projects/${projectId}/upload`} className="nav-link">
          Upload document
        </Link>
        <div className="stat">
          Entities: <b>{head.entities.length}</b> · Relations: <b>{head.relations.length}</b>
        </div>
        <div className="mode-toggle" role="group" aria-label="Graph view mode">
          <button className={mode === '3d' ? 'active' : ''} onClick={() => setMode('3d')}>
            3D
          </button>
          <button className={mode === '2d' ? 'active' : ''} onClick={() => setMode('2d')}>
            2D
          </button>
        </div>
      </header>

      <main className="with-detail">
        <section className="graph-panel">
          {loading && <div className="overlay">Loading graph…</div>}
          {error && <div className="overlay error">Failed to load graph: {error}</div>}
          {!loading && !error && (
            <Graph3D
              head={head}
              mode={mode}
              filter={filter}
              selectedEntityId={selectedId}
              onSelectEntity={selectEntity}
              blastEntityIds={blastIds}
            />
          )}

          {blastIds.length > 0 && (
            <div className="blast-banner" role="status">
              Blast radius: {blastIds.length} node(s) highlighted
              <button type="button" onClick={() => setBlastIds([])}>
                Clear
              </button>
            </div>
          )}

          <div className="filter-panel" aria-label="Filter">
            <div className="fp-title">System groups</div>
            {GROUPS.map((g) => (
              <label key={g}>
                <input
                  type="checkbox"
                  checked={!hiddenGroups.has(g)}
                  onChange={() => setHiddenGroups((s) => toggle(s, g))}
                />
                <span className="fp-sw" style={{ background: GROUP_STYLES[g].color }} />
                {GROUP_STYLES[g].label}
              </label>
            ))}
            <div className="fp-title">Document types</div>
            {ENTITY_TYPES.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={!hiddenTypes.has(t)}
                  onChange={() => setHiddenTypes((s) => toggle(s, t))}
                />
                <span className="fp-ico">{TYPE_STYLES[t].icon}</span>
                {TYPE_STYLES[t].label}
              </label>
            ))}
          </div>
        </section>

        <aside className="side-panel">
          <nav className="side-tabs" role="tablist" aria-label="Side panel">
            <button
              role="tab"
              aria-selected={tab === 'document'}
              className={tab === 'document' ? 'active' : ''}
              onClick={() => setTab('document')}
            >
              Document
            </button>
            <button
              role="tab"
              aria-selected={tab === 'editor'}
              className={tab === 'editor' ? 'active' : ''}
              onClick={() => setTab('editor')}
            >
              {selected ? 'Edit' : 'New'}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'workbench'}
              className={tab === 'workbench' ? 'active' : ''}
              onClick={() => setTab('workbench')}
            >
              Workbench
            </button>
            <button
              role="tab"
              aria-selected={tab === 'ask'}
              className={tab === 'ask' ? 'active' : ''}
              onClick={() => setTab('ask')}
            >
              Ask
            </button>
          </nav>

          <div className="side-body">
            {tab === 'document' &&
              (selected ? (
                <>
                  <DocViewer entity={selected} onSelectEntity={selectEntity} />
                  <DetailPanel
                    entity={selected}
                    head={head}
                    onSelectEntity={selectEntity}
                    onClose={() => setSelectedId(null)}
                  />
                </>
              ) : (
                <div className="side-empty">Select a node to view its document.</div>
              ))}

            {tab === 'editor' &&
              (branchId !== null ? (
                <EntityEditor
                  key={selected?.entityId ?? 'new'}
                  branchId={branchId}
                  initial={selected}
                  onCommitted={(entityId) => {
                    refresh();
                    selectEntity(entityId);
                  }}
                />
              ) : (
                <div className="side-empty">No branch available yet.</div>
              ))}

            {tab === 'workbench' && branchId !== null && (
              <Workbench
                baseBranchId={branchId}
                onHighlightBlast={setBlastIds}
                onBranchChange={(b) => {
                  setBranchId(b);
                  refresh();
                }}
              />
            )}

            {tab === 'ask' && branchId !== null && (
              <AskPanel branchId={branchId} onSelectEntity={selectEntity} />
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
