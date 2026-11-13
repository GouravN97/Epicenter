import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Temporary: local copy of the shared contract until `shared/` is on main. See src/contract/README.md.
      '@epicenter/shared': '/src/contract/index.ts',
    },
  },
  // One .env in the repo root is shared with the server (see .env.example); only VITE_* reaches the browser.
  envDir: '..',
  server: { port: 5173, strictPort: true },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
