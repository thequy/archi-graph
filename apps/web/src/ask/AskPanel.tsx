// AskPanel — RAG question/answer. The user types a question; api.ask returns a
// RagAnswer (answer text + citations). Citations render as buttons; clicking one
// selects the source node in the graph (onSelectEntity with the citation's
// entityId) — the two-way-sync constraint for RAG.
//
// The answer text is treated as PLAIN TEXT (rendered into a <p>, never
// dangerouslySetInnerHTML) so there is no injection surface here.

import { useState } from 'react';
import type { RagAnswer } from '@archi-graph/shared';
import { api } from '../api/client';

export interface AskPanelProps {
  branchId: string;
  onSelectEntity: (entityId: string) => void;
}

export function AskPanel({ branchId, onSelectEntity }: AskPanelProps): JSX.Element {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.ask(branchId, q);
      setAnswer(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="ask-panel" aria-label="Ask">
      <form onSubmit={submit} className="ask-form">
        <label htmlFor="ask-q">Question</label>
        <textarea
          id="ask-q"
          rows={2}
          value={question}
          placeholder="Ask about the architecture…"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Asking…' : 'Ask'}
        </button>
      </form>

      {error && <div className="ask-error">{error}</div>}

      {answer && (
        <div className="ask-answer">
          <p className="ask-text">{answer.answer}</p>
          {answer.citations.length > 0 && (
            <div className="ask-citations">
              <div className="ask-cite-title">Sources</div>
              <ul>
                {answer.citations.map((c) => (
                  <li key={c.entityId}>
                    <button
                      type="button"
                      className="ask-cite"
                      onClick={() => onSelectEntity(c.entityId)}
                      title={`Go to ${c.shortTitle}`}
                    >
                      <span className="ask-cite-code">{c.code}</span>
                      <span className="ask-cite-name">{c.shortTitle}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
