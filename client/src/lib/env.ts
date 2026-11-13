/** API origin, no trailing slash. */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

/**
 * Mock mode: the UI runs with no backend (plan §12.1). Enable with `npm run dev:mock`
 * or VITE_USE_MOCK=true. Switching to the real backend is this one flag.
 */
export const USE_MOCK: boolean = import.meta.env.MODE === 'mock' || import.meta.env.VITE_USE_MOCK === 'true';
