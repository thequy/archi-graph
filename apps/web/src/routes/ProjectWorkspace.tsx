// ProjectWorkspace — route adapter for /projects/:projectId.
//
// Pulls projectId from the URL and hands it to the graph App, which resolves
// THAT project's `main` branch before loading the graph. A missing param (not
// reachable through the defined routes, but typed as optional by react-router)
// bounces back to the projects home rather than rendering a broken App.

import { Navigate, useParams } from 'react-router-dom';
import { App } from '../App';

export function ProjectWorkspace(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return <Navigate to="/" replace />;
  // key forces a fresh App (and its bootstrap) when switching projects.
  return <App key={projectId} projectId={projectId} />;
}
