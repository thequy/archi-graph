// App shell: fetches the branch head-state from the API and renders it in the
// three.js graph (Graph3D). Owns the central UI state that the POC kept in a
// global `state` object — now React state: the active branch, the 2D/3D mode,
// the group/type filter, and the selected entity (two-way synced with the
// graph via selectedEntityId prop + onSelectEntity callback).
//
// The document viewer (marked + DOMPurify) and the flow (reactflow) are present
// as dependencies per the global constraints; the detail panel renders the
// selected entity's markdown safely. Branch/diff/blast/RAG wiring beyond graph
// render belongs to later tasks — the typed client exposes those already.

import { useEffect, useMemo, useState } from 'react';
import type { Group, HeadState, EntityType } from '@archi-graph/shared';
import { GROUPS, ENTITY_TYPES } from '@archi-graph/shared';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from './api/client';
import { Graph3D, type GraphFilter } from './graph/Graph3D';
import type { LayoutMode } from './graph/layout';
import { GROUP_STYLES, TYPE_STYLES } from './graph/styles';

const DEFAULT_BRANCH = 'main';

export function App(): JSX.Element {
  const [head, setHead] = useState<HeadState>({ entities: [], relations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LayoutMode>('3d');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenGroups, setHiddenGroups] = useState<Set<Group>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<EntityType>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getGraph(DEFAULT_BRANCH)
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

  const filter: GraphFilter = useMemo(
    () => ({ hiddenGroups: [...hiddenGroups], hiddenTypes: [...hiddenTypes] }),
    [hiddenGroups, hiddenTypes],
  );

  const selected = useMemo(
    () => head.entities.find((e) => e.entityId === selectedId) ?? null,
    [head, selectedId],
  );

  const selectedHtml = useMemo(() => {
    if (!selected) return '';
    const raw = marked.parse(selected.contentMarkdown, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [selected]);

  function toggle<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo" />
        <div>
          <h1>Archi-Graph</h1>
          <div className="sub">Architecture Knowledge Graph</div>
        </div>
        <span className="spacer" />
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

      <main className={selected ? 'with-detail' : ''}>
        <section className="graph-panel">
          {loading && <div className="overlay">Loading graph…</div>}
          {error && <div className="overlay error">Failed to load graph: {error}</div>}
          {!loading && !error && (
            <Graph3D
              head={head}
              mode={mode}
              filter={filter}
              selectedEntityId={selectedId}
              onSelectEntity={setSelectedId}
            />
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

        {selected && (
          <aside className="detail-panel">
            <div className="detail-head">
              <span
                className="d-type"
                style={{ background: TYPE_STYLES[selected.type].color }}
              >
                {TYPE_STYLES[selected.type].code}
              </span>
              <button className="close" onClick={() => setSelectedId(null)} title="Close">
                ✕
              </button>
            </div>
            <h2 className="d-title">{selected.title}</h2>
            <div className="d-meta">
              {GROUP_STYLES[selected.group].label} · {selected.tier} · {selected.metadata.status}
            </div>
            <div className="md-body" dangerouslySetInnerHTML={{ __html: selectedHtml }} />
          </aside>
        )}
      </main>
    </div>
  );
}
