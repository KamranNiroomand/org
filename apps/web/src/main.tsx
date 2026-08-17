import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter, Navigate } from 'react-router-dom';
import { Shell } from './components/Shell';
import { SettingsProvider } from './lib/settings';
import { CalendarPage } from './pages/CalendarPage';
import { FinancesPage } from './pages/FinancesPage';
import { IdeasPage } from './pages/IdeasPage';
import { InvestmentsPage } from './pages/InvestmentsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { TodayPage } from './pages/TodayPage';
import { TodoPage } from './pages/TodoPage';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // This is a local server; refetching on every window focus is noise.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: 'today', element: <TodayPage /> },
      { path: 'todo', element: <TodoPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:id', element: <ProjectsPage /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'finances', element: <FinancesPage /> },
      { path: 'investments', element: <InvestmentsPage /> },
      { path: 'ideas', element: <IdeasPage /> },
      { path: 'ideas/:id', element: <IdeasPage /> },
      { path: '*', element: <Navigate to="/today" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <RouterProvider router={router} />
      </SettingsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
