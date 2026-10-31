import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Entity } from '@archi-graph/shared';
import { DocViewer } from './DocViewer';

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    entityId: 'e1',
    type: 'lld',
    code: 'LLD-01',
    shortTitle: 'Web',
    group: 'soe',
    tier: 't0',
    title: 'Frontend — Web',
    metadata: { author: 'Guild', date: '2026-03-10', status: 'stable', tags: ['frontend'] },
    contentMarkdown: '# Hello\n\nSome **bold** text.',
    flow: null,
    links: [],
    ...overrides,
  };
}

describe('DocViewer', () => {
  it('renders markdown content as HTML', () => {
    render(<DocViewer entity={entity()} onSelectEntity={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
    expect(screen.getByText('bold')).toBeInTheDocument();
  });

  it('sanitizes markdown: a <script> tag in content is stripped', () => {
    const malicious = entity({
      contentMarkdown: 'Safe text <script>window.__pwned = true;</script> after',
    });
    const { container } = render(<DocViewer entity={malicious} onSelectEntity={() => {}} />);
    // The rendered HTML must not contain a <script> element.
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('<script');
    expect(screen.getByText(/Safe text/)).toBeInTheDocument();
  });

  it('renders links[] as external anchors with rel="noopener" and target _blank', () => {
    const withLinks = entity({
      links: [
        { provider: 'github', name: 'Repo', url: 'https://github.com/acme/repo' },
      ],
    });
    render(<DocViewer entity={withLinks} onSelectEntity={() => {}} />);
    const anchor = screen.getByRole('link', { name: /Repo/ }) as HTMLAnchorElement;
    expect(anchor).toBeInTheDocument();
    expect(anchor.getAttribute('href')).toBe('https://github.com/acme/repo');
    expect(anchor.getAttribute('rel')).toContain('noopener');
    expect(anchor.getAttribute('target')).toBe('_blank');
  });

  it('drops non-http(s) links (e.g. javascript: URLs) from the source list', () => {
    const withBadLink = entity({
      links: [
        // eslint-disable-next-line no-script-url
        { provider: 'other', name: 'Evil', url: 'javascript:alert(1)' },
        { provider: 'confluence', name: 'Docs', url: 'http://example.com/docs' },
      ],
    });
    render(<DocViewer entity={withBadLink} onSelectEntity={() => {}} />);
    expect(screen.queryByRole('link', { name: /Evil/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Docs/ })).toBeInTheDocument();
  });
});
