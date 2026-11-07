import { CATEGORIES, PRESETS, type AssetPreset } from '../world/assets.ts';
import { MODELER_PREFIX, getModelBlob, modelLabel } from '../world/modelStore.ts';
import { CATEGORY_COLORS, icon } from './icons.ts';
import { confirmDialog, h, pickFile, pickFiles, showMenu, toast, type MenuItem } from './ui.ts';
import { models } from './models.ts';
import { textureLabel, textureLibrary, type TextureEntry } from '../world/landscape/textures.ts';

// Content Browser (unten): Assets nach Ordnern, per Drag & Drop in den Viewport oder Doppelklick platzieren.
// Ordner „Texturen“: Material-Sets für Landscape-Layer (Doppelklick = dem gewählten Layer zuweisen).

const TEX_FOLDERS: Record<string, TextureEntry['group'] | null> = {
  Texturen: null,
  'Texturen/Prozedural': 'proc',
  'Texturen/Projekt': 'project',
  'Texturen/Importiert': 'idb',
};

export type Folder = 'Alle' | string;

export class ContentBrowser {
  private folder: Folder = 'Alle';
  private tree: HTMLElement;
  private grid: HTMLElement;
  private search: HTMLInputElement;
  private path: HTMLElement;
  /** Gerade gezogenes Asset (dataTransfer ist während dragover nicht lesbar) */
  static dragging: AssetPreset | null = null;
  onPlace?: (preset: AssetPreset) => void;
  /** Modell im Modeler-Tab öffnen */
  onOpenModel?: (ref: string) => void;
  /** Neues Modell im Modeler-Tab anlegen */
  onNewModel?: () => void;

  constructor(root: HTMLElement) {
    this.search = h('input', { class: 'search', type: 'text', placeholder: 'Assets durchsuchen…', spellcheck: 'false', style: 'max-width:280px' });
    this.search.addEventListener('input', () => this.renderGrid());
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    const importBtn = h('button', { class: 'btn', html: `${icon('upload')}Importieren`, title: '.glb-Modell oder (im Ordner Texturen) ein Textur-Set importieren' });
    importBtn.addEventListener('click', () => (this.folder.startsWith('Texturen') ? void this.importTextures() : void this.importModel()));
    const newModelBtn = h('button', { class: 'btn', html: `${icon('modeler')}Neues Modell`, title: 'Eigenes 3D-Modell im Modeler-Tab bauen (wie in Blender)' });
    newModelBtn.addEventListener('click', () => this.onNewModel?.());
    this.path = h('span', { style: 'color:var(--text-dim);margin-left:8px' });
    this.tree = h('div', { class: 'content-tree' });
    this.grid = h('div', { class: 'content-grid' });
    root.append(
      h('div', { class: 'panel-tabs' }, h('div', { class: 'panel-tab active', html: `${icon('folder')}Content Browser` })),
      h('div', { class: 'panel-toolbar' }, importBtn, newModelBtn, this.path, h('div', { class: 'tb-spacer' }), this.search),
      h('div', { class: 'content-main' }, this.tree, this.grid),
    );
    models.onChange(() => this.render());
    textureLibrary().onChange(() => this.render());
    this.render();
  }

  private textures(folder: string): TextureEntry[] {
    const g = TEX_FOLDERS[folder];
    return textureLibrary()
      .entries()
      .filter((e) => !g || e.group === g);
  }

  private presets(): AssetPreset[] {
    const modelPresets = models.all.map(
      (ref): AssetPreset => ({
        id: `model:${ref}`,
        label: modelLabel(ref),
        category: ref.startsWith(MODELER_PREFIX) ? 'Modelle/Eigene' : ref.startsWith('idb:') ? 'Modelle/Importiert' : 'Modelle/Projekt',
        type: 'model',
        icon: ref.startsWith(MODELER_PREFIX) ? 'modeler' : 'model',
        // eigene Modelle bringen ihre Kollision aus dem Modeler mit
        props: ref.startsWith(MODELER_PREFIX) ? { model: ref, collision: 'auto' } : { model: ref },
      }),
    );
    return [...PRESETS, ...modelPresets];
  }

  render(): void {
    const all = this.presets();
    const count = (f: string) => (f in TEX_FOLDERS ? this.textures(f).length : all.filter((p) => f === 'Alle' || p.category === f || p.category.startsWith(f + '/')).length);
    const item = (f: string, label: string, sub = false) => {
      const el = h('div', { class: `tree-item${sub ? ' sub' : ''}${this.folder === f ? ' active' : ''}`, html: `${icon('folder')}<span>${label}</span>` }, h('span', { class: 'count' }, String(count(f))));
      el.addEventListener('click', () => {
        this.folder = f;
        this.render();
      });
      return el;
    };
    this.tree.replaceChildren(
      item('Alle', 'Alle Assets'),
      ...CATEGORIES.flatMap((c) => (c === 'Modelle' ? [item(c, c), item('Modelle/Eigene', 'Eigene', true), item('Modelle/Projekt', 'Projekt', true), item('Modelle/Importiert', 'Importiert', true)] : [item(c, c)])),
      item('Texturen', 'Texturen'),
      item('Texturen/Prozedural', 'Prozedural', true),
      item('Texturen/Projekt', 'Projekt', true),
      item('Texturen/Importiert', 'Importiert', true),
    );
    this.renderGrid();
  }

  private renderTextures(): void {
    const q = this.search.value.trim().toLowerCase();
    const list = this.textures(this.folder).filter((e) => !q || e.label.toLowerCase().includes(q));
    this.path.textContent = `Inhalt › ${this.folder.replace('/', ' › ')}`;
    const lib = textureLibrary();
    this.grid.replaceChildren(
      ...list.map((e) => {
        const img = h('img', { class: 'tex-thumb', alt: '' }) as HTMLImageElement;
        void lib.thumbnail(e.ref).then((u) => (img.src = u));
        const tile = h(
          'div',
          { class: 'tile', title: `${e.label}\nDoppelklick: dem gewählten Landscape-Layer zuweisen (Landscape-Modus, Werkzeug „Malen“)` },
          h('div', { class: 'thumb' }, img),
          h('div', { class: 'bar', style: 'background:#8a6d3b' }),
          h('div', { class: 'label' }, e.label),
        );
        if (e.group === 'idb') {
          const del = h('div', { class: 'del', title: 'Aus dem Browser löschen', html: icon('trash', 'width="12" height="12"') });
          del.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (await confirmDialog('Textur löschen', `„${e.label}“ aus dem Browser-Speicher löschen? Layer, die sie verwenden, zeigen dann Erde.`, 'Löschen', true)) {
              await lib.remove(e.ref);
            }
          });
          tile.append(del);
        }
        tile.addEventListener('dblclick', () => {
          if (!lib.pick(e.ref)) toast('Erst in den Landscape-Modus wechseln, Werkzeug „Malen“ und einen Layer wählen', 'info', 4000);
        });
        return tile;
      }),
    );
    if (!list.length) {
      const hint =
        this.folder === 'Texturen/Projekt'
          ? 'Keine Projekt-Texturen. Lege je Set einen Ordner in public/assets/textures/ an (z. B. fels/fels_albedo.png, fels_normal.png, fels_roughness.png).'
          : this.folder === 'Texturen/Importiert'
            ? 'Noch nichts importiert. „Importieren“ wählt die Bilder eines Sets (Albedo, Normal, Roughness, AO, Height).'
            : 'Keine passenden Texturen.';
      this.grid.append(h('div', { class: 'empty-hint', style: 'grid-column:1/-1' }, hint));
    }
  }

  private renderGrid(): void {
    if (this.folder.startsWith('Texturen')) return this.renderTextures();
    const q = this.search.value.trim().toLowerCase();
    const list = this.presets().filter(
      (p) => (this.folder === 'Alle' || p.category === this.folder || p.category.startsWith(this.folder + '/')) && (!q || p.label.toLowerCase().includes(q)),
    );
    this.path.textContent = `Inhalt › ${this.folder.replace('/', ' › ')}`;
    this.grid.replaceChildren(
      ...list.map((p) => {
        const cat = p.category.split('/')[0];
        const color = CATEGORY_COLORS[cat] ?? '#888';
        const tile = h(
          'div',
          { class: 'tile', draggable: 'true', title: `${p.label}\nZiehen zum Platzieren · Doppelklick: vor der Kamera einfügen` },
          h('div', { class: 'thumb', style: `color:${color}`, html: icon(p.icon) }),
          h('div', { class: 'bar', style: `background:${color}` }),
          h('div', { class: 'label' }, p.label),
        );
        const own = p.category === 'Modelle/Eigene';
        if (own) tile.title = `${p.label}
Doppelklick: im Modeler bearbeiten · Ziehen: im Level platzieren · Rechtsklick: mehr`;
        if (p.category === 'Modelle/Importiert' || own) {
          const del = h('div', { class: 'del', title: 'Aus dem Browser löschen', html: icon('trash', 'width="12" height="12"') });
          del.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (await confirmDialog('Modell löschen', `„${p.label}“ aus dem Browser-Speicher löschen? Objekte, die es verwenden, zeigen dann nur noch einen Platzhalter.`, 'Löschen', true)) {
              await models.remove(String(p.props?.model));
            }
          });
          tile.append(del);
        }
        tile.addEventListener('dragstart', (e) => {
          ContentBrowser.dragging = p;
          e.dataTransfer?.setData('application/x-bodycam-asset', p.id);
          e.dataTransfer!.effectAllowed = 'copy';
        });
        tile.addEventListener('dragend', () => (ContentBrowser.dragging = null));
        tile.addEventListener('dblclick', () => (own ? this.onOpenModel?.(String(p.props?.model)) : this.onPlace?.(p)));
        if (p.type === 'model') {
          tile.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showMenu(this.modelMenu(p), { x: e.clientX, y: e.clientY });
          });
        }
        return tile;
      }),
    );
    if (!list.length) {
      const hint = this.folder.startsWith('Modelle')
        ? this.folder === 'Modelle/Eigene'
          ? 'Noch keine eigenen Modelle. Klicke „Neues Modell“, um eins im Modeler zu bauen.'
          : 'Keine Modelle. Lege .glb-Dateien nach public/assets/models/ oder klicke „Importieren“.'
        : 'Keine passenden Assets.';
      this.grid.append(h('div', { class: 'empty-hint', style: 'grid-column:1/-1' }, hint));
    }
  }

  private modelMenu(p: AssetPreset): MenuItem[] {
    const ref = String(p.props?.model);
    const own = ref.startsWith(MODELER_PREFIX);
    const items: MenuItem[] = [
      { heading: p.label },
      { label: own ? 'Im Modeler bearbeiten' : 'Im Modeler öffnen (als Kopie)', icon: 'modeler', action: () => this.onOpenModel?.(ref) },
      { label: 'Im Level platzieren', icon: 'levelPlace', action: () => this.onPlace?.(p) },
      {
        label: 'Als .glb herunterladen',
        icon: 'download',
        action: async () => {
          const blob = await getModelBlob(ref);
          if (!blob) return toast('Modell nicht gefunden', 'error');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${p.label}.glb`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        },
      },
    ];
    if (ref.startsWith('idb:')) {
      items.push(
        { separator: true },
        {
          label: 'Löschen',
          icon: 'trash',
          action: async () => {
            if (await confirmDialog('Modell löschen', `„${p.label}“ aus dem Browser-Speicher löschen? Objekte, die es verwenden, zeigen dann nur noch einen Platzhalter.`, 'Löschen', true)) await models.remove(ref);
          },
        },
      );
    }
    return items;
  }

  /** Ordner wechseln (z. B. nach dem Speichern im Modeler) */
  showFolder(f: Folder): void {
    this.folder = f;
    this.render();
  }

  private async importTextures(): Promise<void> {
    const files = await pickFiles('.png,.jpg,.jpeg,.webp');
    if (!files.length) return;
    try {
      const ref = await textureLibrary().import(files);
      this.folder = 'Texturen/Importiert';
      this.render();
      toast(`Textur-Set „${textureLabel(ref)}“ importiert — Doppelklick weist es dem gewählten Layer zu`, 'ok', 4000);
    } catch (e) {
      toast((e as Error).message, 'error', 5000);
    }
  }

  private async importModel(): Promise<void> {
    const file = await pickFile('.glb');
    if (!file) return;
    try {
      const ref = await models.import(file);
      this.folder = 'Modelle/Importiert';
      this.render();
      toast(`Modell „${modelLabel(ref)}“ importiert — jetzt in den Viewport ziehen`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
}
