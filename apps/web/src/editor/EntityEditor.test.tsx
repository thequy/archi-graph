// EntityEditor test — the Diagrams authoring section (Slice B, Task 6).
//
// The api client is mocked (no network). We assert the diagrams editor:
//   1. Adds a diagram row (kind defaults to 'system'), lets the author set a
//      title + mermaid source.
//   2. On save, createEntity receives an entity whose diagrams[0] carries the
//      authored kind/title/mermaid — i.e. diagrams flow through the commit path.
//
// MermaidDiagram is mocked so the preview does not depend on mermaid's layout
// engine (absent in jsdom); its own sanitization is covered in its own test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const createEntity = vi.fn();
const listPatterns = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    createEntity: (...a: unknown[]) => createEntity(...a),
    listPatterns: (...a: unknown[]) => listPatterns(...a),
  },
}));

// Stub the preview: it would otherwise invoke mermaid (no jsdom layout).
vi.mock('../diagram/MermaidDiagram', () => ({
  MermaidDiagram: ({ mermaid }: { mermaid: string }) => (
    <div data-testid="mermaid-preview">{mermaid}</div>
  ),
}));

import { EntityEditor } from './EntityEditor';

describe('EntityEditor — diagrams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createEntity.mockResolvedValue({ entityId: 'e-new', commitId: 'c1' });
    listPatterns.mockResolvedValue([]);
  });

  it('adds a system diagram and persists it through createEntity', async () => {
    render(<EntityEditor branchId="b1" onCommitted={() => {}} />);

    // Required title so the form is submittable.
    fireEvent.change(screen.getByLabelText(/^title$/i), {
      target: { value: 'My Service' },
    });

    // Add a diagram row.
    fireEvent.click(screen.getByRole('button', { name: /add diagram/i }));

    // Fill in the diagram's title + mermaid source. kind defaults to 'system'.
    fireEvent.change(screen.getByLabelText(/diagram title/i), {
      target: { value: 'System Context' },
    });
    fireEvent.change(screen.getByLabelText(/mermaid source/i), {
      target: { value: 'graph TD; A-->B' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create entity/i }));

    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(1));
    const [, entity] = createEntity.mock.calls[0];
    expect(entity.diagrams).toBeDefined();
    expect(entity.diagrams).toHaveLength(1);
    expect(entity.diagrams[0].kind).toBe('system');
    expect(entity.diagrams[0].title).toBe('System Context');
    expect(entity.diagrams[0].mermaid).toBe('graph TD; A-->B');
    expect(typeof entity.diagrams[0].id).toBe('string');
    expect(entity.diagrams[0].id.length).toBeGreaterThan(0);
  });

  it('removes a diagram row', async () => {
    render(<EntityEditor branchId="b1" onCommitted={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'My Service' } });

    // Let the async pattern catalog load settle (it resolves to []) so its
    // state update happens inside act — avoids a not-wrapped-in-act warning.
    await waitFor(() => expect(listPatterns).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /add diagram/i }));
    expect(screen.getByLabelText(/diagram title/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove diagram/i }));
    expect(screen.queryByLabelText(/diagram title/i)).toBeNull();
  });
});

describe('EntityEditor — appliesPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createEntity.mockResolvedValue({ entityId: 'e-new', commitId: 'c1' });
    listPatterns.mockResolvedValue([
      {
        id: 'pt1',
        slug: 'singleton',
        name: 'Singleton',
        category: 'gof',
        intent: '',
        whenToUse: '',
        pros: '',
        cons: '',
        mermaid: null,
        kind: null,
        flow: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'pt2',
        slug: 'cqrs',
        name: 'CQRS',
        category: 'system-design',
        intent: '',
        whenToUse: '',
        pros: '',
        cons: '',
        mermaid: null,
        kind: null,
        flow: null,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  it('selects a pattern and persists its slug through createEntity', async () => {
    render(<EntityEditor branchId="b1" onCommitted={() => {}} />);

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'My Service' } });

    // Catalog loads async; the pattern checkbox appears once listPatterns resolves.
    const singleton = await screen.findByLabelText(/singleton/i);
    fireEvent.click(singleton);

    fireEvent.click(screen.getByRole('button', { name: /create entity/i }));

    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(1));
    const [, entity] = createEntity.mock.calls[0];
    expect(entity.appliesPatterns).toContain('singleton');
    expect(entity.appliesPatterns).not.toContain('cqrs');
  });

  it('omits appliesPatterns entirely when none are selected', async () => {
    render(<EntityEditor branchId="b1" onCommitted={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'My Service' } });
    // Wait for the catalog so we know the section rendered, then save with none picked.
    await screen.findByLabelText(/singleton/i);

    fireEvent.click(screen.getByRole('button', { name: /create entity/i }));
    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(1));
    const [, entity] = createEntity.mock.calls[0];
    expect(entity.appliesPatterns).toBeUndefined();
  });
});
