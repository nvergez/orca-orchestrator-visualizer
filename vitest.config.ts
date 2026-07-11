import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// One runner, two seams (#12 "Testing Decisions"): the server seam drives a real
// fixture database in a node environment; the client seam renders React in jsdom.
// Vitest stays a dev dependency — it never reaches the `npx` user.
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
        plugins: [react()],
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
