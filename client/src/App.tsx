import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';
import { connectSocket, disconnectSocket } from './lib/socket';
import { useAuth } from './state/authStore';

export function App() {
  const status = useAuth((s) => s.status);
  const token = useAuth((s) => s.token);

  useEffect(() => {
    void useAuth.getState().init();
  }, []);

  // The socket follows the session: open once authenticated, closed on logout.
  useEffect(() => {
    if (status === 'authed' && token) connectSocket(token);
    else if (status === 'anon') disconnectSocket();
  }, [status, token]);

  return <RouterProvider router={router} />;
}
