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
});
