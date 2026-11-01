// ProjectsHome test — the Projects landing page (route `/`).
//
// Two behaviours matter:
//   1. On mount it lists projects (api.listProjects) and renders one item per
//      project.
//   2. The create form POSTs via api.createProject and, on success, navigates
//      to the new project's graph route (/projects/:id).
//
// The api client is mocked (no network), and navigation is asserted by
// rendering the page inside a MemoryRouter with a catch-all route that echoes
// the current location. We use fireEvent (matching the rest of the suite — no
// @testing-library/user-event dependency in this workspace).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ProjectSummary } from '../api/client';

const listProjects = vi.fn();
const createProject = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    listProjects: (...a: unknown[]) => listProjects(...a),
    createProject: (...a: unknown[]) => createProject(...a),
  },
}));

import { ProjectsHome } from './ProjectsHome';

const projects: ProjectSummary[] = [
  { id: 'p1', name: 'Alpha', description: 'first project', createdAt: '2026-01-01' },
  { id: 'p2', name: 'Beta', description: null, createdAt: '2026-01-02' },
];

// A tiny probe that renders wherever navigation lands so the test can assert
// the destination path.
function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderHome(): void {
  render(
    <MemoryRouter
      initialEntries={['/']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/projects/:projectId" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectsHome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProjects.mockResolvedValue(projects);
  });

  it('lists the projects returned by the api', async () => {
    renderHome();

    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('creates a project and navigates to its graph route', async () => {
    createProject.mockResolvedValue({
      id: 'p3',
      name: 'Gamma',
      description: null,
      createdAt: '2026-01-03',
    });

    renderHome();
    await waitFor(() => expect(listProjects).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Gamma' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith('Gamma', undefined));
    // On success we land on the new project's graph route.
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/projects/p3'),
    );
  });

  it('shows an empty state when there are no projects', async () => {
    listProjects.mockResolvedValue([]);
    renderHome();
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });
});
