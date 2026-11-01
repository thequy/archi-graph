import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ProjectsHome } from './routes/ProjectsHome';
import { ProjectWorkspace } from './routes/ProjectWorkspace';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/projects/:projectId" element={<ProjectWorkspace />} />
        {/* Unknown paths fall back to the projects home. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
