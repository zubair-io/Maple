/** One small WASM instance per export service, shared by every item in a batch. */
import type { RecipeTarget } from './export-recipe-store';
import { EXPORT_ENCODERS, type ExportRecipe } from '../generated/export-recipe.generated';

export class RecipeFilenameEngine {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (name: string) => void; reject: (error: Error) => void }
  >();
  name(target: RecipeTarget, recipe: ExportRecipe): Promise<string> {
    const encoder = EXPORT_ENCODERS.find((entry) => entry.format === recipe.format);
    if (!encoder) return Promise.reject(new Error('Unsupported export format'));
    if (!this.worker) this.open();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({
        id,
        template: recipe.namingTemplate,
        filename: target.filename,
        ext: encoder.extension,
        capturedAt: target.capturedAt,
        index: target.index,
      });
    });
  }
  close(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values())
      pending.reject(new Error('Filename engine unavailable. Reload and retry.'));
    this.pending.clear();
  }
  private open(): void {
    const worker = new Worker(new URL('./export-filename.worker', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<{ id: number; name?: string; error?: string }>) => {
      const pending = this.pending.get(event.data.id);
      this.pending.delete(event.data.id);
      if (!pending) return;
      if (event.data.name) pending.resolve(event.data.name);
      else pending.reject(new Error(event.data.error ?? 'Filename generation failed'));
    };
    worker.onerror = () => this.close();
    this.worker = worker;
  }
}
