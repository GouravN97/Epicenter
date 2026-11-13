import { create } from 'zustand';
import type { LoginResponse, Role, UserDTO } from '../lib/contract';
import { api, bindAuth, HttpError } from '../lib/api';

const TOKEN_KEY = 'epicenter.token';
const USER_KEY = 'epicenter.user';

function readStored(): { token: string | null; user: UserDTO | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    return { token, user: token && raw ? (JSON.parse(raw) as UserDTO) : null };
  } catch {
    return { token: null, user: null };
  }
}

function writeStored(token: string | null, user: UserDTO | null): void {
  try {
    if (token && user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    // Storage unavailable (private mode): the session lasts until reload.
  }
}

interface AuthState {
  /** `checking` until the stored token has been verified with /auth/me. */
  status: 'checking' | 'authed' | 'anon';
  token: string | null;
  user: UserDTO | null;
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'checking',
  token: null,
  user: null,

  async init() {
    const { token, user } = readStored();
    if (!token) return set({ status: 'anon', token: null, user: null });
    set({ token, user });
    try {
      const fresh = await api.get<UserDTO>('/auth/me');
      writeStored(token, fresh);
      set({ status: 'authed', user: fresh });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) return; // onUnauthorized already logged out
      // API unreachable: keep the cached session so the shell renders; the connection badge shows the outage.
      if (user) set({ status: 'authed' });
      else get().logout();
    }
  },

  async login(email, password) {
    const { token, user } = await api.post<LoginResponse>('/auth/login', { email, password });
    writeStored(token, user);
    set({ status: 'authed', token, user });
  },

  logout() {
    writeStored(null, null);
    set({ status: 'anon', token: null, user: null });
  },
}));

bindAuth({
  getToken: () => useAuth.getState().token,
  onUnauthorized: () => useAuth.getState().logout(),
});

export function hasRole(user: UserDTO | null, ...roles: Role[]): boolean {
  return !!user && roles.includes(user.role);
}
