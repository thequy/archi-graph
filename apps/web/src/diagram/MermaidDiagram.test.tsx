// MermaidDiagram tests — the SANITIZATION contract (Review Focus).
//
// Mermaid's real renderer needs a browser layout engine that jsdom lacks, so we
// do NOT depend on real mermaid output here. Instead MermaidDiagram accepts an
// injectable `renderer` (a function returning a Promise<string> of SVG). The
// component's job under test is: whatever SVG string the renderer returns, it is
// run through DOMPurify BEFORE it enters the DOM. The tests feed the renderer an
// SVG carrying a <script>/onerror payload and assert the mounted DOM is clean.
//
// This isolates the security-critical behaviour from mermaid's layout, which is
// exercised by the real default renderer in the browser (and the build).

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MermaidDiagram } from './MermaidDiagram';

describe('MermaidDiagram', () => {
  it('renders the SVG returned by the renderer into the DOM', async () => {
    const renderer = async () => '<svg data-testid="svg-ok"><g><text>ok</text></g></svg>';
    const { container } = render(
      <MermaidDiagram mermaid="graph TD; A-->B" kind="system" renderer={renderer} />,
    );
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    expect(container.querySelector('[data-testid="svg-ok"]')).not.toBeNull();
  });

  it('SANITIZES the rendered SVG: a smuggled <script> is stripped from the DOM', async () => {
    // Simulates a mermaid label/node that smuggled active content into the SVG.
    const renderer = async () =>
      '<svg><g><text>label</text></g><script>window.__pwned = true;</script></svg>';
    const { container } = render(
      <MermaidDiagram mermaid="graph TD; A-->B" kind="system" renderer={renderer} />,
    );
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    // Defense in depth: no <script> element and no raw <script markup reaches DOM.
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('<script');
  });

  it('SANITIZES event handlers: an onerror/onload attribute is stripped', async () => {
    const renderer = async () =>
      '<svg><image href="x" onerror="window.__pwned = true"></image></svg>';
    const { container } = render(
      <MermaidDiagram mermaid="graph TD; A-->B" kind="sequence" renderer={renderer} />,
    );
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain('onerror');
  });

  it('shows a graceful fallback (not a crash) when the renderer throws', async () => {
    const renderer = async () => {
      throw new Error('boom');
    };
    render(<MermaidDiagram mermaid="not valid" kind="system" renderer={renderer} />);
    expect(await screen.findByText(/could not render diagram/i)).toBeInTheDocument();
  });

  it('does NOT re-render mermaid when only the renderer identity changes (no churn)', async () => {
    // The editor's live preview re-renders the parent on every keystroke. If a
    // parent passes an INLINE renderer, it has a new identity each render. The
    // render effect must depend on the mermaid SOURCE only, not the renderer
    // identity — otherwise every keystroke forces a full mermaid re-render.
    const calls: string[] = [];
    // A fresh inline renderer per parent render (new identity each time).
    const makeRenderer = () => async (src: string) => {
      calls.push(src);
      return `<svg data-testid="svg-ok"><g><text>${src}</text></g></svg>`;
    };

    const { rerender, container } = render(
      <MermaidDiagram mermaid="graph TD; A-->B" kind="system" renderer={makeRenderer()} />,
    );
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    expect(calls).toHaveLength(1);

    // Re-render the parent with a NEW inline renderer identity but the SAME
    // mermaid source — this must NOT re-invoke the renderer.
    rerender(
      <MermaidDiagram mermaid="graph TD; A-->B" kind="system" renderer={makeRenderer()} />,
    );
    rerender(
      <MermaidDiagram mermaid="graph TD; A-->B" kind="system" renderer={makeRenderer()} />,
    );
    // Give any (incorrectly scheduled) effect a chance to run.
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    // Changing the mermaid SOURCE still re-renders, using the LATEST renderer.
    rerender(
      <MermaidDiagram mermaid="graph TD; A-->C" kind="system" renderer={makeRenderer()} />,
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe('graph TD; A-->C');
  });
});
