// MermaidDiagram — renders a Mermaid source string to SVG and inserts it into
// the DOM *sanitized*. This runs in PARALLEL to the react-flow `flow` renderer
// (DocViewer may show both); it owns the `entity.diagrams[]` rendering.
//
// SECURITY (Review Focus): two independent defenses stand between Mermaid source
// and live DOM markup:
//   1. mermaid is initialized with `securityLevel: 'strict'` — mermaid itself
//      sanitizes/strips script and event handlers it would emit.
//   2. Whatever SVG string the renderer returns is run through DOMPurify BEFORE
//      it is inserted via dangerouslySetInnerHTML (defense in depth). Even if a
//      <script>/onerror were smuggled through a label or node, DOMPurify strips
//      it so it never reaches the DOM as active content.
//
// TESTABILITY: mermaid's real renderer needs a browser layout engine (absent in
// jsdom), and its output is non-deterministic. So the SVG producer is injected
// via the optional `renderer` prop. In the app it defaults to a mermaid-backed
// renderer; tests pass a stub returning an SVG with a payload and assert the
// mounted DOM is clean. The sanitization contract is therefore tested
// deterministically, decoupled from mermaid's layout. See MermaidDiagram.test.

import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { DiagramSpec } from '@archi-graph/shared';

/** Produces an SVG string for the given mermaid source. Injectable for tests. */
export type MermaidRenderer = (mermaid: string, id: string) => Promise<string>;

export interface MermaidDiagramProps {
  mermaid: string;
  kind: DiagramSpec['kind'];
  /** Override the SVG producer (tests). Defaults to the real mermaid renderer. */
  renderer?: MermaidRenderer;
}

// A module-level id counter so each render target gets a unique DOM id (mermaid
// requires a unique id per render call).
let seq = 0;
function nextId(): string {
  seq += 1;
  return `mermaid-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// The default renderer lazy-loads mermaid (keeps it out of the initial bundle)
// and initializes it once with strict security. mermaid v10+ `render` is async
// and returns `{ svg }`.
let mermaidInit = false;
const defaultRenderer: MermaidRenderer = async (src, id) => {
  const mermaid = (await import('mermaid')).default;
  if (!mermaidInit) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    mermaidInit = true;
  }
  const { svg } = await mermaid.render(id, src);
  return svg;
};

export function MermaidDiagram({
  mermaid,
  kind,
  renderer = defaultRenderer,
}: MermaidDiagramProps): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Guards against setting state after unmount / stale async resolution.
  const latest = useRef(0);

  useEffect(() => {
    const token = ++latest.current;
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    (async () => {
      try {
        const raw = await renderer(mermaid, nextId());
        // Defense in depth: sanitize mermaid's output before it enters the DOM.
        const clean = DOMPurify.sanitize(raw, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        if (!cancelled && token === latest.current) setSvg(clean);
      } catch {
        if (!cancelled && token === latest.current) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mermaid, renderer]);

  if (failed) {
    return (
      <div className="mermaid-diagram mermaid-error" role="img" aria-label={`${kind} diagram`}>
        Could not render diagram.
      </div>
    );
  }

  if (svg === null) {
    return (
      <div className="mermaid-diagram" data-kind={kind} role="img" aria-label={`${kind} diagram`}>
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram"
      data-kind={kind}
      role="img"
      aria-label={`${kind} diagram`}
      // Sanitized SVG only — see the SECURITY note above.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
