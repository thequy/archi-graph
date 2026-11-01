// DocViewer — center panel. Renders the selected entity's markdown SAFELY
// (marked -> DOMPurify.sanitize -> dangerouslySetInnerHTML) and, when the entity
// carries a `flow`, lazy-mounts the reactflow diagram. Source links render as
// external anchors (rel="noopener", target _blank) and only http(s) URLs survive
// (see safeLinks). Ported from the POC viewer, now typed against the shared DTOs.
//
// SECURITY: the sanitize step is load-bearing — a <script> (or other active
// content) authored into contentMarkdown must never reach the DOM as live markup.
// DocViewer.test asserts this directly.

import { Suspense, lazy, useMemo } from 'react';
import type { Entity } from '@archi-graph/shared';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { safeLinks } from './safeLinks';
import { MermaidDiagram } from '../diagram/MermaidDiagram';

// Lazy so the reactflow chunk only loads when a flow is actually shown.
const FlowDiagram = lazy(() => import('./FlowDiagram'));

export interface DocViewerProps {
  entity: Entity;
  /** Two-way sync: in-doc entity references can navigate the graph. */
  onSelectEntity: (entityId: string) => void;
}

function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  // Sanitize BEFORE it is ever inserted via dangerouslySetInnerHTML.
  return DOMPurify.sanitize(raw);
}

function hasFlow(flow: unknown): boolean {
  if (!flow || typeof flow !== 'object') return false;
  const f = flow as { nodes?: unknown; edges?: unknown };
  return Array.isArray(f.nodes) && Array.isArray(f.edges);
}

export function DocViewer({ entity }: DocViewerProps): JSX.Element {
  const html = useMemo(() => renderMarkdown(entity.contentMarkdown), [entity.contentMarkdown]);
  const links = useMemo(() => safeLinks(entity.links), [entity.links]);
  const showFlow = useMemo(() => hasFlow(entity.flow), [entity.flow]);
  // `diagrams` is undefined (not []) when absent — default before mapping.
  const diagrams = entity.diagrams ?? [];

  return (
    <article className="doc-viewer" aria-label="Document viewer">
      <h1 className="dv-title">{entity.title}</h1>

      <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />

      {/* Mermaid diagrams render in PARALLEL to the react-flow flow below —
          both may appear for the same entity. */}
      {diagrams.length > 0 && (
        <section className="dv-diagrams" aria-label="Diagrams">
          {diagrams.map((d) => (
            <figure key={d.id} className="dv-diagram">
              {d.title && <figcaption className="dv-diagram-title">{d.title}</figcaption>}
              <MermaidDiagram mermaid={d.mermaid} kind={d.kind} />
            </figure>
          ))}
        </section>
      )}

      {showFlow && (
        <Suspense fallback={<div className="dv-flow-loading">Loading diagram…</div>}>
          <FlowDiagram flow={entity.flow} />
        </Suspense>
      )}

      {links.length > 0 && (
        <section className="src-section" aria-label="Source files">
          <div className="src-title">Source files</div>
          <ul className="src-list">
            {links.map((l) => (
              <li key={`${l.provider}:${l.url}`}>
                <a
                  className="src-link"
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {l.name}
                  <span className="src-provider"> ({l.provider})</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
