import { defineConfig } from 'vite';

// Single-page static site. `npm run build` emits a self-contained dist/ folder
// that can be dropped on any static host (Netlify, Vercel, GitHub Pages, S3...).
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false, open: false },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
