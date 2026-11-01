// UploadPage — route `/projects/:projectId/upload`.
//
// Flow: pick a file → upload (POST /projects/:projectId/files, multipart field
// `file`) → the API returns { fileId, summaryStatus:'pending' } and a background
// worker extracts + summarizes the document. We then POLL GET /files/:id on a
// fixed interval until summary_status becomes 'done' (an entity was created —
// we link to it within the project graph) or 'failed' (we show a message).
//
// POLLING SAFETY (brief constraint):
//   - Interval: POLL_INTERVAL_MS (2s) — gentle on the API, responsive enough.
//   - Stop conditions: summary_status 'done' or 'failed', a hard cap of
//     MAX_ATTEMPTS (→ timeout message), and component unmount.
//   - The interval is held in a ref and ALWAYS cleared by the effect cleanup, so
//     there are no leaked intervals and no setState-after-unmount: an `alive`
//     flag gates every setState in an async poll callback.
//
// The entity link points at /projects/:projectId?entity=:entityId — the graph
// App reads the project route; the query param marks which entity to focus. We
// use a query param (not a new route) so this stays decoupled from the graph's
// internal selection wiring while still being a real, shareable href.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { api, type FileMeta, type SummaryStatus } from '../api/client';

// Poll cadence + safety cap. 2s × 150 ≈ 5 minutes before we give up.
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 150;

type Phase = 'idle' | 'uploading' | 'polling' | 'done' | 'failed' | 'timeout';

export function UploadPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();

  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileId, setFileId] = useState<string | null>(null);
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mirrors `phase` so the (stable) poll effect can read the latest value
  // without resubscribing each render.
  const attemptsRef = useRef(0);

  // Terminal statuses stop the poll.
  const isTerminal = (s: SummaryStatus): boolean => s === 'done' || s === 'failed';

  // Poll effect: runs only while we have a fileId AND are in the 'polling'
  // phase. Sets up a single interval; the cleanup clears it on unmount and
  // whenever the dependencies change (e.g. phase → done). An `alive` flag guards
  // every setState so a late-resolving getFile after unmount is a no-op.
  useEffect(() => {
    if (!fileId || phase !== 'polling') return;
    let alive = true;
    attemptsRef.current = 0;

    const tick = async (): Promise<void> => {
      if (!alive) return;
      attemptsRef.current += 1;
      try {
        const m = await api.getFile(fileId);
        if (!alive) return;
        setMeta(m);
        if (m.summaryStatus === 'done') {
          setPhase('done');
        } else if (m.summaryStatus === 'failed') {
          setPhase('failed');
        } else if (attemptsRef.current >= MAX_ATTEMPTS) {
          setPhase('timeout');
        }
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('failed');
      }
    };

    const id = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fileId, phase]);

  const onUpload = useCallback(
    async (e: FormEvent): Promise<void> => {
      e.preventDefault();
      if (!file || !projectId || phase === 'uploading' || phase === 'polling') return;
      setPhase('uploading');
      setError(null);
      setMeta(null);
      setFileId(null);
      try {
        const res = await api.uploadFile(projectId, file);
        setFileId(res.fileId);
        // Begin polling; the effect above picks this up.
        setPhase('polling');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase('failed');
      }
    },
    [file, projectId, phase],
  );

  // Missing param isn't reachable via the defined route, but react-router types
  // it optional — bounce home rather than render a broken page.
  if (!projectId) return <Navigate to="/" replace />;

  const status: SummaryStatus | null = meta?.summaryStatus ?? null;
  const busy = phase === 'uploading' || phase === 'polling';

  return (
    <div className="upload-page">
      <header className="app-header">
        <div className="logo" />
        <div>
          <h1>Archi-Graph</h1>
          <div className="sub">Upload document</div>
        </div>
        <span className="spacer" />
        <Link to={`/projects/${projectId}`} className="nav-link back-link">
          ← Back to graph
        </Link>
      </header>

      <main className="upload-main">
        <section aria-label="Upload a document">
          <form onSubmit={onUpload}>
            <label htmlFor="upload-file">File</label>
            <input
              id="upload-file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
            <button type="submit" disabled={!file || busy}>
              {phase === 'uploading' ? 'Uploading…' : 'Upload'}
            </button>
          </form>

          {error && (
            <div className="overlay error" role="alert">
              {error}
            </div>
          )}

          {phase !== 'idle' && (
            <div className="upload-status" role="status" aria-live="polite">
              {phase === 'uploading' && <p>Uploading the document…</p>}
              {phase === 'polling' && (
                <p>
                  Processing document — status: <b>{status ?? 'pending'}</b>
                </p>
              )}
              {phase === 'done' && meta && (
                <p>
                  Done — an entity was created from this document.{' '}
                  {meta.entityId ? (
                    <Link to={`/projects/${projectId}?entity=${meta.entityId}`} className="nav-link">
                      View the created entity
                    </Link>
                  ) : (
                    'No entity id was returned.'
                  )}
                </p>
              )}
              {phase === 'failed' && (
                <p className="error">
                  Ingest failed{status ? ` (status: ${status})` : ''}. Please try another document.
                </p>
              )}
              {phase === 'timeout' && (
                <p className="error">
                  Still processing after a while — the summary did not complete in time. Refresh to
                  check again later.
                </p>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
