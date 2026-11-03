import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const MODELS_DIR = resolve('public/assets/models');
const MODELS_ID = 'virtual:bodycam-models';

/** Liefert die Liste aller .glb/.gltf-Dateien unter public/assets/models (für den Content Browser des Editors) */
function modelList(): Plugin {
  const resolvedId = '\0' + MODELS_ID;
  const scan = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return scan(full);
      return /\.(glb|gltf)$/i.test(name) ? ['/assets/models/' + relative(MODELS_DIR, full).replace(/\\/g, '/')] : [];
    });
  };
  return {
    name: 'bodycam-models',
    resolveId: (id) => (id === MODELS_ID ? resolvedId : undefined),
    load: (id) => (id === resolvedId ? `export default ${JSON.stringify(scan(MODELS_DIR).sort())};` : undefined),
    configureServer(server) {
      server.watcher.add(MODELS_DIR);
      const refresh = (file: string) => {
        if (!resolve(file).startsWith(MODELS_DIR)) return;
        const mod = server.moduleGraph.getModuleById(resolvedId);
        if (mod) server.moduleGraph.invalidateModule(mod);
        // Kein Full-Reload (würde ungespeicherte Editor-Arbeit verwerfen) — der Editor aktualisiert die Liste selbst
        server.ws.send({ type: 'custom', event: 'bodycam:models', data: scan(MODELS_DIR).sort() });
      };
      server.watcher.on('add', refresh);
      server.watcher.on('unlink', refresh);
    },
  };
}

export default defineConfig({
  root: '.',
  plugins: [modelList()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        editor: resolve('editor.html'),
      },
    },
  },
});
