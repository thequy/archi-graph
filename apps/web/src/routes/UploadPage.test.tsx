// UploadPage test — route `/projects/:projectId/upload`.
//
// Behaviours covered:
//   1. Pick a file + submit → api.uploadFile is called with (projectId, file),
//      the page shows a "pending" status and begins polling api.getFile.
//   2. The poll transitions pending → done across getFile calls; the UI updates
//      to "done" and renders a link to the created entity within the project
//      graph (/projects/:projectId → the entity's id).
//   3. A 'failed' summary_status shows a failure message (and stops polling).
//
// The api client is mocked (no network). Polling is driven with Vitest fake
// timers: the component polls on a fixed interval and we advance the clock to
// make getFile resolve its transitioning values. We render inside MemoryRouter
// so the entity link resolves to a real route href.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { FileMeta } from '../api/client';

const uploadFile = vi.fn();
const getFile = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    uploadFile: (...a: unknown[]) => uploadFile(...a),
    getFile: (...a: unknown[]) => getFile(...a),
  },
}));

import { UploadPage } from './UploadPage';

function fileMeta(overrides: Partial<FileMeta>): FileMeta {
  return {
    id: 'f1',
    projectId: 'p1',
    entityId: null,
    filename: 'doc.txt',
    mime: 'text/plain',
    sizeBytes: 11,
    storagePath: '/tmp/f1',
    extractedChars: null,
    summaryStatus: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderUpload(): void {
  render(
    <MemoryRouter
      initialEntries={['/projects/p1/upload']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/projects/:projectId/upload" element={<UploadPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function pickAndUpload(): void {
  const file = new File(['hello world'], 'doc.txt', { type: 'text/plain' });
  const input = screen.getByLabelText(/file/i) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: /upload/i }));
}

describe('UploadPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('uploads the picked file then polls until done and links to the entity', async () => {
    uploadFile.mockResolvedValue({ fileId: 'f1', summaryStatus: 'pending' });
    // First poll still pending, second poll done with an entity id.
    getFile
      .mockResolvedValueOnce(fileMeta({ summaryStatus: 'pending' }))
      .mockResolvedValueOnce(fileMeta({ summaryStatus: 'done', entityId: 'e9', extractedChars: 11 }));

    renderUpload();
    pickAndUpload();

    // Flush the upload promise (fake timers → no waitFor; just flush microtasks).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(uploadFile).toHaveBeenCalledWith('p1', expect.any(File));

    // First poll (pending).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getFile).toHaveBeenCalledWith('f1');
    expect(screen.getByText(/pending/i)).toBeInTheDocument();

    // Second poll (done).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const link = screen.getByRole('link', { name: /view the created entity/i });
    expect(link.getAttribute('href')).toContain('/projects/p1');
    expect(link.getAttribute('href')).toContain('e9');

    // Polling has stopped: advancing further triggers no more getFile calls.
    const callsAfterDone = getFile.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getFile.mock.calls.length).toBe(callsAfterDone);
  });

  it('shows a failure message when the summary fails and stops polling', async () => {
    uploadFile.mockResolvedValue({ fileId: 'f1', summaryStatus: 'pending' });
    getFile.mockResolvedValueOnce(fileMeta({ summaryStatus: 'failed' }));

    renderUpload();
    pickAndUpload();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(uploadFile).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByText(/failed/i)).toBeInTheDocument();

    const callsAfterFail = getFile.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getFile.mock.calls.length).toBe(callsAfterFail);
  });

  it('does not poll before a file is uploaded', async () => {
    uploadFile.mockResolvedValue({ fileId: 'f1', summaryStatus: 'pending' });
    getFile.mockResolvedValue(fileMeta({}));

    renderUpload();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getFile).not.toHaveBeenCalled();
  });
});
