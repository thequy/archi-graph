// PatternDetail — one pattern at route `/patterns/:slug` (Slice D).
//
// Loads the pattern (GET /patterns/:slug) + its used-by reverse index
// (GET /patterns/:slug/used-by) in parallel, and renders:
//   • name + category badge
//   • intent / when-to-use / pros / cons (free-form strings from the catalog)
//   • a concept diagram via MermaidDiagram (REUSED from Slice B) when the
//     pattern carries a mermaid source — MermaidDiagram sanitizes its output, so
//     no new unsanitized HTML path is introduced here.
//   • a "Used by" section listing every component that applies the pattern, each
//     linking into that project's graph scoped to the entity
//     (/projects/:projectId?entity=:entityId).

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DiagramSpec } from '@archi-graph/shared';
import { api, type Pattern, type PatternUsedBy } from '../api/client';
import { MermaidDiagram } from '../diagram/MermaidDiagram';

const CATEGORY_LABELS: Record<string, string> = {
  gof: 'GoF (Gang of Four)',
  'system-design': 'System Design',
};

// The pattern's `kind` is a free-form string|null; MermaidDiagram's `kind` is
// the DiagramSpec union ('system' | 'sequence'). Map to a valid member,
// defaulting to 'system' for a generic concept diagram.
function diagramKind(kind: string | null): DiagramSpec['kind'] {
  return kind === 'sequence' ? 'sequence' : 'system';
}

export function PatternDetail(): JSX.Element {
  const { slug } = useParams<{ slug: string }>();
  const [pattern, setPattern] = useState<Pattern | null>(null);
  const [usedBy, setUsedBy] = useState<PatternUsedBy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setPattern(null);
    setUsedBy(null);
    setError(null);
    Promise.all([api.getPattern(slug), api.getPatternUsedBy(slug)])
      .then(([p, u]) => {
        if (!cancelled) {
          setPattern(p);
          setUsedBy(u);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="pattern-detail">
      <header className="app-header">
        <div className="logo" />
        <div>
          <h1>{pattern ? pattern.name : 'Pattern'}</h1>
          <div className="sub">
            {pattern ? (CATEGORY_LABELS[pattern.category] ?? pattern.category) : 'Pattern Wiki'}
          </div>
        </div>
        <span className="spacer" />
        <Link to="/patterns" className="nav-link">
          All patterns
        </Link>
      </header>

      <main className="pattern-detail-main">
        {error && (
          <div className="overlay error" role="alert">
            {error}
          </div>
        )}
        {!error && pattern === null && <div className="side-empty">Loading pattern…</div>}

        {pattern !== null && (
          <>
            <section className="pattern-fields" aria-label="Pattern details">
              <h3>Intent</h3>
              <p>{pattern.intent}</p>

              <h3>When to use</h3>
              <p>{pattern.whenToUse}</p>

              <h3>Pros</h3>
              <p>{pattern.pros}</p>

              <h3>Cons</h3>
              <p>{pattern.cons}</p>
            </section>

            {pattern.mermaid && pattern.mermaid.trim() && (
              <section className="pattern-diagram" aria-label="Concept diagram">
                <h3>Concept diagram</h3>
                <MermaidDiagram mermaid={pattern.mermaid} kind={diagramKind(pattern.kind)} />
              </section>
            )}

            <section className="pattern-used-by" aria-label="Used by">
              <h3>Used by</h3>
              {usedBy === null && <div className="side-empty">Loading…</div>}
              {usedBy !== null && usedBy.length === 0 && (
                <div className="side-empty">Not applied by any component yet.</div>
              )}
              {usedBy !== null && usedBy.length > 0 && (
                <ul>
                  {usedBy.map((u) => (
                    <li key={`${u.projectId}:${u.entityId}`}>
                      <Link
                        to={`/projects/${u.projectId}?entity=${encodeURIComponent(u.entityId)}`}
                        className="used-by-item"
                      >
                        <span className="used-by-code">{u.code}</span>
                        <span className="used-by-title">{u.title}</span>
                        <span className="used-by-project">{u.projectName}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
