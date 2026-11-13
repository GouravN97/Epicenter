import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute, RequireRole } from './components/ProtectedRoute';
import { ChaosLab } from './pages/ChaosLab';
import { IncidentRoom } from './pages/IncidentRoom';
import { Incidents } from './pages/Incidents';
import { Login } from './pages/Login';
import { NodeDetail } from './pages/NodeDetail';
import { NotFound } from './pages/NotFound';
import { Overview } from './pages/Overview';
import { Pipeline } from './pages/Pipeline';
import { Topology } from './pages/Topology';

// Routes from plan §9.1.
export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
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
]);
