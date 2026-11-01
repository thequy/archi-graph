// App bootstrap test — the branch-id resolution Review Focus (CRITICAL 1),
// now PROJECT-SCOPED (Task 4).
//
// The API keys branches by UUID (branch_id is a uuid column), but the UI knows
// the default branch only by its NAME ('main'). The app MUST resolve main's
// UUID from listBranches(projectId) BEFORE it calls getGraph — sending the name
// 'main' (or a projectId) to a uuid column 500s the API. With the router, the
// App receives a `projectId` and resolves THAT project's main branch: it must
// call listBranches(projectId) and getGraph with the resolved UUID, never the
// literal 'main' and never the projectId.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BranchSummary } from './api/client';

// --- Mock the api client used across the App tree. ---
const listBranches = vi.fn();
const getGraph = vi.fn();

vi.mock('./api/client', () => ({
  api: {
    listBranches: (...a: unknown[]) => listBranches(...a),
    getGraph: (...a: unknown[]) => getGraph(...a),
    // Other methods are used only by lazily-rendered side panels, not on boot.
    createEntity: vi.fn(),
    deleteEntity: vi.fn(),
    createRelation: vi.fn(),
    deleteRelation: vi.fn(),
    createCandidate: vi.fn(),
    getDiff: vi.fn(),
    blastForNode: vi.fn(),
    blastForCandidate: vi.fn(),
    ask: vi.fn(),
    merge: vi.fn(),
  },
}));

// Graph3D renders a WebGL canvas via three.js — stub it so jsdom stays happy.
vi.mock('./graph/Graph3D', () => ({
  Graph3D: () => null,
}));

import { App } from './App';

// App now renders a react-router <Link> (the "Upload document" nav), so it must
// mount inside a router. A MemoryRouter keeps these unit tests self-contained.
function renderApp(projectId: string): void {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App projectId={projectId} />
    </MemoryRouter>,
  );
}

const PROJECT_ID = 'p1';
const MAIN_UUID = '11111111-1111-1111-1111-111111111111';

const branches: BranchSummary[] = [
  {
    id: MAIN_UUID,
    name: 'main',
    headCommitId: 'c0',
    parentCommitId: null,
    author: 'sys',
    createdAt: '2026-01-01',
  },
];

describe('App bootstrap — project-scoped branch-id resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGraph.mockResolvedValue({ entities: [], relations: [] });
  });

  it("resolves the project's main UUID from listBranches(projectId) before loading the graph", async () => {
    listBranches.mockResolvedValue(branches);

    renderApp(PROJECT_ID);

    // listBranches must happen first; getGraph only after the id is resolved.
    await waitFor(() => expect(getGraph).toHaveBeenCalled());

    // Scoped to the project: listBranches is called WITH the project id.
    expect(listBranches).toHaveBeenCalledWith(PROJECT_ID);
    // The crux: getGraph is called with the resolved UUID, NOT 'main' or the
    // project id.
    expect(getGraph).toHaveBeenCalledWith(MAIN_UUID);
    expect(getGraph).not.toHaveBeenCalledWith('main');
    expect(getGraph).not.toHaveBeenCalledWith(PROJECT_ID);
  });

  it('never calls getGraph before listBranches resolves', async () => {
    let resolveBranches!: (b: BranchSummary[]) => void;
    listBranches.mockReturnValue(
      new Promise<BranchSummary[]>((res) => {
        resolveBranches = res;
      }),
    );

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App projectId={PROJECT_ID} />
      </MemoryRouter>,
    );

    // listBranches is in flight; getGraph must not have fired yet.
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    expect(getGraph).not.toHaveBeenCalled();

    resolveBranches(branches);
    await waitFor(() => expect(getGraph).toHaveBeenCalledWith(MAIN_UUID));
  });

  it('handles a missing main branch gracefully (empty state, no getGraph, no crash)', async () => {
    listBranches.mockResolvedValue([]);

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App projectId={PROJECT_ID} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    // No main branch resolved ⇒ graph load stays gated; empty-state header renders.
    expect(getGraph).not.toHaveBeenCalled();
    expect(screen.getByText('Archi-Graph')).toBeInTheDocument();
  });
});
