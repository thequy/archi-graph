// PatternDetail test — route `/patterns/:slug`.
//
// Behaviours covered:
//   1. On mount it loads the pattern (api.getPattern) + its used-by list
//      (api.getPatternUsedBy), rendering name/category/intent/when/pros/cons.
//   2. When the pattern carries a mermaid source, the concept diagram is
//      rendered via MermaidDiagram (mocked here — its sanitization is covered in
//      its own test).
//   3. The "Used by" section lists each component with a link into the project
//      graph scoped to the entity (/projects/:projectId?entity=:entityId).
//
// The api client is mocked (no network). MermaidDiagram is stubbed so the test
// does not depend on mermaid's layout engine (absent in jsdom).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Pattern, PatternUsedBy } from '../api/client';

const getPattern = vi.fn();
const getPatternUsedBy = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    getPattern: (...a: unknown[]) => getPattern(...a),
    getPatternUsedBy: (...a: unknown[]) => getPatternUsedBy(...a),
  },
}));

// Stub the diagram: it would otherwise invoke mermaid (no jsdom layout).
vi.mock('../diagram/MermaidDiagram', () => ({
  MermaidDiagram: ({ mermaid }: { mermaid: string }) => (
    <div data-testid="mermaid">{mermaid}</div>
  ),
}));

import { PatternDetail } from './PatternDetail';

const pattern: Pattern = {
  id: 'pt1',
  slug: 'singleton',
  name: 'Singleton',
  category: 'gof',
  intent: 'Ensure a class has one instance.',
  whenToUse: 'When exactly one instance is required.',
  pros: 'Controlled single access point.',
  cons: 'Hidden global state.',
  mermaid: 'classDiagram\n  class Singleton',
  kind: 'system',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const usedBy: PatternUsedBy[] = [
  { projectId: 'p1', projectName: 'Alpha', entityId: 'e1', code: 'LLD-01', title: 'Config Service' },
];

function renderDetail(slug = 'singleton'): void {
  render(
    <MemoryRouter
      initialEntries={[`/patterns/${slug}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/patterns/:slug" element={<PatternDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PatternDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPattern.mockResolvedValue(pattern);
    getPatternUsedBy.mockResolvedValue(usedBy);
  });

  it('renders the pattern fields, concept diagram and used-by links', async () => {
    renderDetail();

    await waitFor(() => expect(getPattern).toHaveBeenCalledWith('singleton'));
    expect(getPatternUsedBy).toHaveBeenCalledWith('singleton');

    expect(await screen.findByRole('heading', { name: /singleton/i })).toBeInTheDocument();
    expect(screen.getByText(/ensure a class has one instance/i)).toBeInTheDocument();
    expect(screen.getByText(/exactly one instance is required/i)).toBeInTheDocument();
    expect(screen.getByText(/controlled single access point/i)).toBeInTheDocument();
    expect(screen.getByText(/hidden global state/i)).toBeInTheDocument();

    // Concept diagram rendered via MermaidDiagram (stubbed).
    expect(screen.getByTestId('mermaid')).toHaveTextContent('classDiagram');

    // Used-by: a component link into the project graph scoped to the entity.
    const link = screen.getByRole('link', { name: /config service|LLD-01/i });
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('/projects/p1');
    expect(href).toContain('entity=e1');
  });

  it('omits the concept diagram when the pattern has no mermaid source', async () => {
    getPattern.mockResolvedValue({ ...pattern, mermaid: null });
    renderDetail();
    await waitFor(() => expect(getPattern).toHaveBeenCalled());
    await screen.findByRole('heading', { name: /singleton/i });
    expect(screen.queryByTestId('mermaid')).toBeNull();
  });

  it('shows an empty used-by state when no component applies the pattern', async () => {
    getPatternUsedBy.mockResolvedValue([]);
    renderDetail();
    await waitFor(() => expect(getPatternUsedBy).toHaveBeenCalled());
    await screen.findByRole('heading', { name: /singleton/i });
    expect(screen.getByText(/not applied by any component/i)).toBeInTheDocument();
  });
});
