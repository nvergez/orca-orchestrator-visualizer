import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// One runner, two seams (#12 "Testing Decisions"): the server seam drives a real
// fixture database in a node environment; the client seam renders React in jsdom.
// Vitest stays a dev dependency — it never reaches the `npx` user.
//
// The third project is not a seam but a deliverable: `npx orca-viz` is a claim made by the
// manifest and the README rather than by any function, and #22 is where it gets asserted.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/server/**/*.test.ts', 'test/fixtures/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'package',
          environment: 'node',
          include: ['test/package/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        // The same `@` the app is built with (`vite.config.ts`) — the components under test
        // import shadcn's primitives through it, and a suite that resolved them differently
        // would not be testing the bundle that ships.
        resolve: { alias: { '@': fileURLToPath(new URL('./src/client', import.meta.url)) } },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['test/client/**/*.test.tsx'],
          setupFiles: ['test/client/setup.ts'],
        },
      },
    ],
  },
});
