import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

/*
 * Rolldown chunk groups. The heavy 3D and PDF libraries each get their own chunk, so they load lazily (only
 * the scene and the PDF engine import them, through dynamic imports) and cache independently of the app code.
 * Higher priority wins when a module matches several groups.
 *
 * The `vendor` group is not optional: without it Rolldown parks shared modules (react, the preload helper)
 * inside whichever lazy group happens to use them, and the first screen then downloads the whole 3D bundle.
 * Verified by building a throwaway app that imports every heavy library lazily: the entry chunk imports only
 * `vendor` and the runtime.
 */
const CHUNK_GROUPS = [
  {
    name: 'vendor',
    test: /node_modules[\\/](?:react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]|vite[\\/]preload-helper|rolldown[\\/]runtime/,
    priority: 100,
  },
  { name: 'pdfjs', test: /node_modules[\\/]pdfjs-dist[\\/]/, priority: 5 },
  { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 4 },
  { name: 'r3f', test: /node_modules[\\/](?:@react-three[\\/]fiber|react-reconciler)[\\/]/, priority: 4 },
  { name: 'postprocessing', test: /node_modules[\\/](?:@react-three[\\/])?postprocessing[\\/]/, priority: 2 },
  {
    name: 'drei',
    test: /node_modules[\\/](?:@react-three[\\/]drei|maath|three-stdlib|meshline|camera-controls)[\\/]/,
    priority: 1,
  },
];

/*
 * pdf.js reads some data at run time: CMaps (CJK and Arabic encodings), the standard fonts (PDFs that do not embed
 * theirs), the wasm image decoders and the ICC profiles. They are served from our own origin under /pdfjs/ (the
 * CSP's connect-src is 'self'): by a middleware in development and as emitted assets in the build.
 */
const PDFJS_DATA_DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

function pdfjsData(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const mime = (name: string): string =>
    name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  return {
    name: 'enchanted:pdfjs-data',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const match = /^\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/.exec(
          (request.url ?? '').split('?')[0] ?? '',
        );
        if (!match?.[1] || !match[2]) {
          next();
          return;
        }
        try {
          const bytes = readFileSync(join(root, match[1], match[2]));
          response.setHeader('Content-Type', mime(match[2]));
          response.end(bytes);
        } catch {
          response.statusCode = 404;
          response.end();
        }
      });
    },
    generateBundle() {
      for (const directory of PDFJS_DATA_DIRECTORIES) {
        for (const name of readdirSync(join(root, directory))) {
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${directory}/${name}`,
            source: readFileSync(join(root, directory, name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsData()],
  resolve: {
    // `source` lets the dev server and the tests use @enchanted/shared straight from its TypeScript sources.
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    // three.js alone is about 740 kB (190 kB gzip). It is its own lazy chunk that only the 3D scene imports, so the
    // first screen never downloads it; the default 500 kB warning would only repeat that every build.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: { codeSplitting: { groups: CHUNK_GROUPS } },
    },
  },
});
