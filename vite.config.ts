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
    rollupOptions: {
      // **Two pages, and that is the whole of the mode switch** (#74). `index.html` is the live
      // tool and opens an `EventSource`; `replay.html` reads one exported run out of a file and
      // has no transport at all. Which one a browser gets is decided by the server it is talking
      // to — `orca-viz` or `orca-viz --archive` — so "an archived replay never polls" is a fact
      // about what is in the bundle rather than a rule the UI has to keep remembering.
      input: {
        index: fileURLToPath(new URL('./src/client/index.html', import.meta.url)),
        replay: fileURLToPath(new URL('./src/client/replay.html', import.meta.url)),
      },
    },
  },
});
