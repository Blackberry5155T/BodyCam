import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { IMAGE_RE, groupTextureFiles } from './src/world/landscape/textureFiles.ts';

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

const TEXTURES_DIR = resolve('public/assets/textures');
const TEXTURES_ID = 'virtual:bodycam-textures';
/** Kanal-Endungen, die bei losen Dateien zum selben Set gehören (rock_albedo.png + rock_normal.png → "rock") */
const CHANNEL_SUFFIX = /[_\-. ](albedo|basecolor|base_color|diffuse|diff|colou?r|col|normal|nrm|nor|normalgl|normaldx|rough|roughness|rgh|ao|ambientocclusion|occlusion|height|disp|displacement|bump|arm)([_\-. ].*)?$/i;

/**
 * Liefert die Textur-Sets unter public/assets/textures: jeder Unterordner ist ein Set (Albedo, Normal, Rauheit,
 * AO, Höhe — Zuordnung über den Dateinamen), lose Bilder werden über ihren Namensanfang gruppiert.
 */
function textureList(): Plugin {
  const resolvedId = '\0' + TEXTURES_ID;
  const url = (full: string) => '/assets/textures/' + relative(TEXTURES_DIR, full).split('\\').join('/');
  const scan = () => {
    if (!existsSync(TEXTURES_DIR)) return [];
    const sets: { name: string; files: Record<string, string> }[] = [];
    const loose = new Map<string, string[]>();
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const full = join(dir, n);
        return statSync(full).isDirectory() ? walk(full) : IMAGE_RE.test(n) ? [full] : [];
      });
    for (const name of readdirSync(TEXTURES_DIR).sort()) {
      const full = join(TEXTURES_DIR, name);
      if (statSync(full).isDirectory()) {
        const files = groupTextureFiles(walk(full).map(url));
        if (files.albedo || files.normal) sets.push({ name, files: files as Record<string, string> });
      } else if (IMAGE_RE.test(name)) {
        const key = name.replace(/\.[^.]+$/, '').replace(CHANNEL_SUFFIX, '') || name;
        loose.set(key, [...(loose.get(key) ?? []), url(full)]);
      }
    }
    for (const [name, list] of loose) {
      const files = groupTextureFiles(list);
      if (files.albedo || files.normal) sets.push({ name, files: files as Record<string, string> });
    }
    return sets.sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    name: 'bodycam-textures',
    resolveId: (id) => (id === TEXTURES_ID ? resolvedId : undefined),
    load: (id) => (id === resolvedId ? `export default ${JSON.stringify(scan())};` : undefined),
    configureServer(server) {
      server.watcher.add(TEXTURES_DIR);
      const refresh = (file: string) => {
        if (!resolve(file).startsWith(TEXTURES_DIR)) return;
        const mod = server.moduleGraph.getModuleById(resolvedId);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'custom', event: 'bodycam:textures', data: scan() });
      };
      server.watcher.on('add', refresh);
      server.watcher.on('unlink', refresh);
    },
  };
}

export default defineConfig({
  root: '.',
  plugins: [modelList(), textureList()],
  server: {
    port: 5173,
  },
  // ES2022: Top-Level-await (Rapier/WASM wird vor dem Spielstart geladen)
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  // Web Worker (Landscape-Erosion) als ES-Modul
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        editor: resolve('editor.html'),
      },
    },
  },
});
