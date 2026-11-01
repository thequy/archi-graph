// PatternWiki — the global Pattern catalog at route `/patterns` (Slice D).
//
// Lists the whole catalog (GET /patterns) GROUPED by category (gof /
// system-design), each pattern linking to its detail page (/patterns/:slug).
// The catalog is global (no project scope) and read-only here; authoring lives
// in the API seed. An entity "applies" a pattern via the EntityEditor; the
// reverse ("used by") view lives on each pattern's detail page.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Pattern } from '../api/client';

// Fixed display order + labels for the two catalog categories. Any unexpected
// category value still renders (appended after the known ones) so an added
// category never silently disappears.
const CATEGORY_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'gof', label: 'GoF (Gang of Four)' },
  { key: 'system-design', label: 'System Design' },
];

function categoryLabel(key: string): string {
  return CATEGORY_ORDER.find((c) => c.key === key)?.label ?? key;
}

/** Orders category keys: known ones first (fixed order), then any extras. */
function orderedCategories(patterns: Pattern[]): string[] {
  const present = new Set(patterns.map((p) => p.category));
  const known = CATEGORY_ORDER.map((c) => c.key).filter((k) => present.has(k));
  const extras = [...present].filter((k) => !known.includes(k)).sort();
  return [...known, ...extras];
}

export function PatternWiki(): JSX.Element {
  const [patterns, setPatterns] = useState<Pattern[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPatterns()
      .then((ps) => {
        if (!cancelled) {
          setPatterns(ps);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = patterns ? orderedCategories(patterns) : [];

  return (
    <div className="pattern-wiki">
      <header className="app-header">
        <div className="logo" />
        <div>
          <h1>Pattern Wiki</h1>
          <div className="sub">Architecture &amp; design patterns</div>
        </div>
        <span className="spacer" />
        <Link to="/" className="nav-link back-link">
          ← Projects
        </Link>
      </header>

      <main className="pattern-wiki-main">
        {error && (
          <div className="overlay error" role="alert">
            {error}
          </div>
        )}
        {patterns === null && <div className="side-empty">Loading patterns…</div>}
        {patterns !== null && patterns.length === 0 && (
          <div className="side-empty">No patterns in the catalog yet.</div>
        )}
        {patterns !== null &&
          patterns.length > 0 &&
          categories.map((cat) => (
            <section key={cat} className="pattern-category" aria-label={categoryLabel(cat)}>
              <h2>{categoryLabel(cat)}</h2>
              <ul>
                {patterns
                  .filter((p) => p.category === cat)
                  .map((p) => (
                    <li key={p.slug}>
                      <Link to={`/patterns/${p.slug}`} className="pattern-item">
                        <span className="pattern-name">{p.name}</span>
                        {p.intent && <span className="pattern-intent">{p.intent}</span>}
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
      </main>
    </div>
  );
}
