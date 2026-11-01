// PatternWiki test — route `/patterns`.
//
// Behaviours covered:
//   1. On mount it lists the pattern catalog (api.listPatterns) and groups the
//      patterns by category (gof / system-design), rendering a section per
//      category.
//   2. Each pattern links to its detail route /patterns/:slug.
//
// The api client is mocked (no network). Navigation targets are asserted via
// the rendered link hrefs (inside a MemoryRouter).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Pattern } from '../api/client';

const listPatterns = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    listPatterns: (...a: unknown[]) => listPatterns(...a),
  },
}));

import { PatternWiki } from './PatternWiki';

const patterns: Pattern[] = [
  {
    id: 'pt1',
    slug: 'singleton',
    name: 'Singleton',
    category: 'gof',
    intent: 'one instance',
    whenToUse: 'exactly one needed',
    pros: 'controlled access',
    cons: 'global state',
    mermaid: null,
    kind: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'pt2',
    slug: 'cqrs',
    name: 'CQRS',
    category: 'system-design',
    intent: 'separate reads/writes',
    whenToUse: 'read/write differ',
    pros: 'scale',
    cons: 'complexity',
    mermaid: null,
    kind: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  },
];

function renderWiki(): void {
  render(
    <MemoryRouter
      initialEntries={['/patterns']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/patterns" element={<PatternWiki />} />
        <Route path="/patterns/:slug" element={<div>detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PatternWiki', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPatterns.mockResolvedValue(patterns);
  });

  it('lists patterns grouped by category with links to each detail', async () => {
    renderWiki();

    await waitFor(() => expect(listPatterns).toHaveBeenCalled());

    // Both category headings render.
    expect(await screen.findByRole('heading', { name: /gof/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /system.?design/i })).toBeInTheDocument();

    // Each pattern links to its detail route.
    const singleton = screen.getByRole('link', { name: /singleton/i });
    expect(singleton.getAttribute('href')).toBe('/patterns/singleton');
    const cqrs = screen.getByRole('link', { name: /cqrs/i });
    expect(cqrs.getAttribute('href')).toBe('/patterns/cqrs');
  });

  it('places each pattern under its own category section', async () => {
    renderWiki();
    await waitFor(() => expect(listPatterns).toHaveBeenCalled());

    const gofSection = (await screen.findByRole('heading', { name: /gof/i }))
      .closest('section') as HTMLElement;
    expect(within(gofSection).getByText(/singleton/i)).toBeInTheDocument();
    expect(within(gofSection).queryByText(/^CQRS$/)).toBeNull();
  });

  it('shows an empty state when the catalog is empty', async () => {
    listPatterns.mockResolvedValue([]);
    renderWiki();
    await waitFor(() => expect(listPatterns).toHaveBeenCalled());
    expect(await screen.findByText(/no patterns/i)).toBeInTheDocument();
  });
});
