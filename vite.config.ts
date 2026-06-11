import { readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The demon sprite picker auto-populates from public/assets/demons/ — but a
// static host can't list a directory, so this plugin publishes the folder's
// contents as assets/demons/manifest.json: every base name with a .json+.png
// sheet pair. Dev serves it live from disk (drop a pair in, refresh, it's in
// the dropdown); build emits it as a real file in dist.
const MANIFEST_URL = '/assets/demons/manifest.json';
function demonManifest(): Plugin {
  const dir = path.resolve(__dirname, 'public/assets/demons');
  const listSheets = (): string[] => {
    const files = new Set(readdirSync(dir));
    return [...files]
      .filter((f) => f.endsWith('.json') && files.has(f.replace(/\.json$/, '.png')))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  };
  return {
    name: 'demon-manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== MANIFEST_URL) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(listSheets()));
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: MANIFEST_URL.slice(1),
        source: JSON.stringify(listSheets()),
      });
    },
  };
}

export default defineConfig({
  base: './',
  // VITE_NO_HMR=1 turns off hot-module reload entirely — the page never
  // auto-refreshes while files change underneath it; reload by hand to pick
  // up new code. Handy while testing live alongside an editing session.
  server: { port: 5173, strictPort: false, hmr: process.env.VITE_NO_HMR ? false : undefined },
  plugins: [demonManifest()],
});
