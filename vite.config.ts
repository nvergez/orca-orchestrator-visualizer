import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The frontend is built ahead of publish and served by the Node server out of the
// package's own dist/ — one process, one port, no CORS (SPEC §2).
export default defineConfig({
  root: 'src/client',
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn's convention, pointed at the client: `@/components/ui/button`, `@/lib/utils`.
    // The server and the shared contract stay on relative paths — they are not in this graph.
    alias: { '@': fileURLToPath(new URL('./src/client', import.meta.url)) },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
