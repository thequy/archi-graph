import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ProjectsHome } from './routes/ProjectsHome';
import { ProjectWorkspace } from './routes/ProjectWorkspace';
import { UploadPage } from './routes/UploadPage';
import { PatternWiki } from './routes/PatternWiki';
import { PatternDetail } from './routes/PatternDetail';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/projects/:projectId" element={<ProjectWorkspace />} />
        <Route path="/projects/:projectId/upload" element={<UploadPage />} />
        <Route path="/patterns" element={<PatternWiki />} />
        <Route path="/patterns/:slug" element={<PatternDetail />} />
        {/* Unknown paths fall back to the projects home. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
