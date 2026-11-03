import { PROJECT_MODELS, deleteImportedModel, importModelFile, listImportedModels } from '../world/modelStore.ts';

// Verfügbare 3D-Modelle für Content Browser und Details-Panel (Projekt-Ordner + im Browser importiert).

class ModelLibrary {
  project: string[] = [...PROJECT_MODELS];
  imported: string[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    void this.refresh();
    // Vite-Plugin meldet neue/gelöschte Dateien in public/assets/models
    import.meta.hot?.on('bodycam:models', (list: string[]) => {
      this.project = list;
      this.emit();
    });
  }

  get all(): string[] {
    return [...this.project, ...this.imported];
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async refresh(): Promise<void> {
    this.imported = await listImportedModels();
    this.emit();
  }

  async import(file: File): Promise<string> {
    const ref = await importModelFile(file);
    await this.refresh();
    return ref;
  }

  async remove(ref: string): Promise<void> {
    await deleteImportedModel(ref);
    await this.refresh();
  }
}

export const models = new ModelLibrary();
