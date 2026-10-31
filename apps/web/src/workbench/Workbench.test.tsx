import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { GraphDiff, BlastRadius } from '@archi-graph/shared';
import type { BranchSummary } from '../api/client';

// --- Mock the API client module used by Workbench/AskPanel. ---
const listBranches = vi.fn();
const createCandidate = vi.fn();
const getDiff = vi.fn();
const blastForCandidate = vi.fn();
const merge = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    listBranches: (...a: unknown[]) => listBranches(...a),
    createCandidate: (...a: unknown[]) => createCandidate(...a),
    getDiff: (...a: unknown[]) => getDiff(...a),
    blastForCandidate: (...a: unknown[]) => blastForCandidate(...a),
    merge: (...a: unknown[]) => merge(...a),
  },
}));

import { Workbench } from './Workbench';

const branches: BranchSummary[] = [
  { id: 'main', name: 'main', headCommitId: 'c0', parentCommitId: null, author: 'sys', createdAt: '2026-01-01' },
  { id: 'cand-1', name: 'feature', headCommitId: 'c1', parentCommitId: 'c0', author: 'dev', createdAt: '2026-02-01' },
];

const diff: GraphDiff = {
  entities: [
    { kind: 'added', id: 'e-new', before: null, after: null },
    { kind: 'updated', id: 'e-upd', before: null, after: null },
    { kind: 'updated', id: 'e-upd2', before: null, after: null },
    { kind: 'deleted', id: 'e-del', before: null, after: null },
  ],
  relations: [{ kind: 'added', id: 'r-new', before: null, after: null }],
} as unknown as GraphDiff;

const blast: BlastRadius = {
  direction: 'downstream',
  nodes: [
    { entityId: 'e-new', distance: 0, via: 'candidate', cause: ['added'] },
    { entityId: 'e-dep', distance: 1, via: 'baseline', cause: ['depends'] },
  ],
} as unknown as BlastRadius;

describe('Workbench', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBranches.mockResolvedValue(branches);
    createCandidate.mockResolvedValue({ branchId: 'cand-1' });
    getDiff.mockResolvedValue(diff);
    blastForCandidate.mockResolvedValue(blast);
    merge.mockResolvedValue({ status: 'clean', commitId: 'merged-1' });
  });

  it('lists branches and shows a diff with added/updated/deleted counts', async () => {
    render(
      <Workbench baseBranchId="main" onHighlightBlast={() => {}} onBranchChange={() => {}} />,
    );

    await waitFor(() => expect(listBranches).toHaveBeenCalled());

    // Pick the candidate branch and ask for the diff.
    fireEvent.change(screen.getByLabelText('Candidate'), { target: { value: 'cand-1' } });
    fireEvent.click(screen.getByRole('button', { name: /diff/i }));

    await waitFor(() => expect(getDiff).toHaveBeenCalledWith('main', 'cand-1'));

    // Counts: 1 added, 2 updated, 1 deleted (entities) + 1 added relation.
    expect(screen.getByTestId('diff-added')).toHaveTextContent('2');
    expect(screen.getByTestId('diff-updated')).toHaveTextContent('2');
    expect(screen.getByTestId('diff-deleted')).toHaveTextContent('1');
  });

  it('runs blast-radius for the candidate and reports the node id set to the host', async () => {
    const onHighlightBlast = vi.fn();
    render(
      <Workbench baseBranchId="main" onHighlightBlast={onHighlightBlast} onBranchChange={() => {}} />,
    );
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Candidate'), { target: { value: 'cand-1' } });
    fireEvent.click(screen.getByRole('button', { name: /blast/i }));

    await waitFor(() => expect(blastForCandidate).toHaveBeenCalledWith('main', 'cand-1', 'downstream'));
    await waitFor(() =>
      expect(onHighlightBlast).toHaveBeenCalledWith(expect.arrayContaining(['e-new', 'e-dep'])),
    );
  });

  it('merges the candidate and reports a clean result', async () => {
    render(
      <Workbench baseBranchId="main" onHighlightBlast={() => {}} onBranchChange={() => {}} />,
    );
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Candidate'), { target: { value: 'cand-1' } });
    fireEvent.click(screen.getByRole('button', { name: /merge/i }));

    await waitFor(() => expect(merge).toHaveBeenCalledWith('cand-1', undefined));
    expect(await screen.findByText(/merged|clean/i)).toBeInTheDocument();
  });

  it('shows conflicts and lets the user resolve then retry the merge', async () => {
    merge
      .mockResolvedValueOnce({
        status: 'conflict',
        conflicts: [{ kind: 'entity', id: 'e-upd', base: null, ours: null, theirs: null }],
      })
      .mockResolvedValueOnce({ status: 'clean', commitId: 'merged-2' });

    render(
      <Workbench baseBranchId="main" onHighlightBlast={() => {}} onBranchChange={() => {}} />,
    );
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Candidate'), { target: { value: 'cand-1' } });
    fireEvent.click(screen.getByRole('button', { name: /merge/i }));

    // Conflict surfaced — the resolve control for the conflicting id appears.
    expect(await screen.findByLabelText(/resolve e-upd/i)).toBeInTheDocument();

    // Resolve by choosing "ours" then retry.
    fireEvent.change(screen.getByLabelText(/resolve e-upd/i), { target: { value: 'ours' } });
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    await waitFor(() =>
      expect(merge).toHaveBeenLastCalledWith('cand-1', { 'e-upd': 'ours' }),
    );
  });
});
