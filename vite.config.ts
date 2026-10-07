import { defineConfig } from 'vite';

// The Amplience importer extension: a static page Amplience loads in an iframe.
export default defineConfig({
  root: 'extension',
  base: './',
  build: { outDir: '../dist/extension', emptyOutDir: true },
  // Amplience frames the extension in a sandbox; without "Allow same origin" its origin is
  // "null", and module scripts then need CORS headers to load.
  server: { port: 5175, cors: { origin: '*' } },
});
