// ProjectsHome — the landing page at route `/`.
//
// Lists the user's projects (GET /projects) and offers a small create form
// (POST /projects). Picking a project navigates to its graph workspace at
// /projects/:projectId; creating one navigates straight into the freshly
// created project (which the API provisions with its own `main` branch).
//
// This is the one place the FE calls the Projects endpoints directly; the graph
// App is purely project-scoped and never lists projects itself.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ProjectSummary } from '../api/client';

export function ProjectsHome(): JSX.Element {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const loadProjects = useCallback(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((ps) => {
        if (!cancelled) {
          setProjects(ps);
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

  useEffect(() => loadProjects(), [loadProjects]);

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || creating) return;
    const trimmedDesc = description.trim();
    setCreating(true);
    setError(null);
    try {
      const project = await api.createProject(
        trimmedName,
        trimmedDesc === '' ? undefined : trimmedDesc,
      );
      // Straight into the new project's graph (it already has its own main).
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  return (
    <div className="projects-home">
      <header className="app-header">
        <div className="logo" />
        <div>
          <h1>Archi-Graph</h1>
          <div className="sub">Projects</div>
        </div>
        <span className="spacer" />
        <Link to="/patterns" className="nav-link">
          Pattern Wiki
        </Link>
      </header>

      <main className="projects-main">
        <section className="projects-list" aria-label="Projects">
          <h2>Your projects</h2>
          {error && (
            <div className="overlay error" role="alert">
              {error}
            </div>
          )}
          {projects === null && <div className="side-empty">Loading projects…</div>}
          {projects !== null && projects.length === 0 && (
            <div className="side-empty">No projects yet. Create one to get started.</div>
          )}
          {projects !== null && projects.length > 0 && (
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <Link to={`/projects/${p.id}`} className="project-item">
                    <span className="project-name">{p.name}</span>
                    {p.description && <span className="project-desc">{p.description}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="projects-create" aria-label="Create a project">
          <h2>New project</h2>
          <form onSubmit={onCreate}>
            <label htmlFor="project-name">Name</label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Payments Platform"
              required
            />

            <label htmlFor="project-description">Description</label>
            <input
              id="project-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />

            <button type="submit" disabled={creating || name.trim() === ''}>
              {creating ? 'Creating…' : 'Create project'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
