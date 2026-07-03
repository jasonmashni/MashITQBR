import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/charts/styles.css';

import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Center, Loader, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { theme } from './theme.js';
import { App } from './App.js';

// Route-level code splitting: each page (and the chart vendor code it pulls
// in) loads on demand instead of inside one monolithic bundle.
const Dashboard = lazy(() => import('./pages/Dashboard.js').then((m) => ({ default: m.Dashboard })));
const Clients = lazy(() => import('./pages/Clients.js').then((m) => ({ default: m.Clients })));
const Integrations = lazy(() => import('./pages/Integrations.js').then((m) => ({ default: m.Integrations })));
const Workspace = lazy(() => import('./pages/Workspace.js').then((m) => ({ default: m.Workspace })));
const Audit = lazy(() => import('./pages/Audit.js').then((m) => ({ default: m.Audit })));
const Settings = lazy(() => import('./pages/Settings.js').then((m) => ({ default: m.Settings })));

const fallback = (
  <Center h="60vh">
    <Loader />
  </Center>
);

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <Notifications position="top-right" />
        <BrowserRouter>
          <Suspense fallback={fallback}>
            <Routes>
              <Route element={<App />}>
                <Route index element={<Dashboard />} />
                <Route path="clients" element={<Clients />} />
                <Route path="clients/:clientId" element={<Workspace />} />
                <Route path="integrations" element={<Integrations />} />
                <Route path="audit" element={<Audit />} />
                <Route path="settings" element={<Settings />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </MantineProvider>
    </React.StrictMode>,
  );
}
