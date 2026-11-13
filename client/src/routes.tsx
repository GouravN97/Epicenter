import { lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute, RequireRole } from './components/ProtectedRoute';
import { RouteError } from './components/RouteError';
import { Login } from './pages/Login';
import { NotFound } from './pages/NotFound';

// Pages load on demand, so the first screen does not wait for the chart and graph libraries
// (uPlot, React Flow) that only some pages use. The shell shows a loading state meanwhile.
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const Overview = named(() => import('./pages/Overview'), 'Overview');
const Topology = named(() => import('./pages/Topology'), 'Topology');
const NodeDetail = named(() => import('./pages/NodeDetail'), 'NodeDetail');
const Incidents = named(() => import('./pages/Incidents'), 'Incidents');
const IncidentRoom = named(() => import('./pages/IncidentRoom'), 'IncidentRoom');
const ChaosLab = named(() => import('./pages/ChaosLab'), 'ChaosLab');
const Pipeline = named(() => import('./pages/Pipeline'), 'Pipeline');

// Routes from plan §9.1.
export const router = createBrowserRouter([
  { path: '/login', element: <Login />, errorElement: <RouteError /> },
  {
    element: <ProtectedRoute />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            // A page that throws is replaced by an error panel inside the shell; navigation keeps working.
            errorElement: <RouteError />,
            children: [
              { path: '/', element: <Overview /> },
              { path: '/topology', element: <Topology /> },
              { path: '/node/:id', element: <NodeDetail /> },
              { path: '/incidents', element: <Incidents /> },
              { path: '/incidents/:id', element: <IncidentRoom /> },
              { path: '/pipeline', element: <Pipeline /> },
              {
                element: <RequireRole roles={['admin']} />,
                children: [{ path: '/chaos', element: <ChaosLab /> }],
              },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
]);
