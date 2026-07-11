import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend is built ahead of publish and served by the Node server out of the
// package's own dist/ — one process, one port, no CORS (SPEC §2).
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
