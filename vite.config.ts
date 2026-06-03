import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

// Dev-only API backing the upgrade-tree balance editor (upgrade-editor.html).
// GET  /__dev/upgrade-tree → src/upgrade-tree.json as it sits on disk.
// POST /__dev/upgrade-tree → validates the body and writes it back, so the
// editor's Save button persists balance changes straight into the repo. Vite
// then hot-reloads the game page (it imports the json), picking the new
// numbers up immediately.
function upgradeTreeEditorApi(): Plugin {
  return {
    name: 'upgrade-tree-editor-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__dev/upgrade-tree', (req, res) => {
        const file = path.join(server.config.root, 'src', 'upgrade-tree.json');
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(file, 'utf8'));
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c: Buffer) => { body += c.toString(); });
          req.on('end', () => {
            try {
              const doc = JSON.parse(body) as Record<string, unknown>;
              // Cheap shape check so a buggy editor can't clobber the file
              // with something the game would crash importing.
              if (!Array.isArray(doc.tasks) || typeof doc.upgrades !== 'object' || typeof doc.layout !== 'object') {
                throw new Error('expected { tasks: [], upgrades, layout }');
              }
              fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
              res.setHeader('Content-Type', 'application/json');
              res.end('{"ok":true}');
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: String(e) }));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  plugins: [upgradeTreeEditorApi()],
});
