import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { Asset } from '../../models/asset';
import {
  DEFAULT_EXPORT_RECIPE,
  EXPORT_ENCODERS,
  parseExportRecipe,
  exportRecipeProblem,
  type ExportRecipe,
} from '../../generated/export-recipe.generated';
import { MuiOverlayShellComponent } from '../../ui/overlay-shell/mui-overlay-shell.component';
import { MuiExportOptionsFieldsComponent } from '../../ui/export-modal/mui-export-options-fields.component';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import { MuiFormFieldComponent } from '../../ui/form-field/mui-form-field.component';
import { MuiSegmentedToggleComponent } from '../../ui/segmented-toggle/mui-segmented-toggle.component';
import { MuiProgressComponent } from '../../ui/progress/mui-progress.component';
import { ExportRecipeQueueService } from '../export-recipe-queue.service';
import {
  savedRecipes,
  saveRecipe,
  deleteRecipe,
  readRecipeDirectory,
} from '../export-recipe-store';
import { downloadBlob } from '../download-blob';

@Component({
  selector: 'app-recipe-export-dialog',
  standalone: true,
  imports: [
    MuiOverlayShellComponent,
    MuiExportOptionsFieldsComponent,
    MuiButtonComponent,
    MuiTextComponent,
    MuiFormFieldComponent,
    MuiSegmentedToggleComponent,
    MuiProgressComponent,
  ],
  templateUrl: './recipe-export-dialog.component.html',
  styleUrl: './recipe-export-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class RecipeExportDialogComponent {
  readonly visible = input(false);
  readonly assets = input<readonly Asset[]>([]);
  readonly dismiss = output<void>();
  readonly queue = inject(ExportRecipeQueueService);
  readonly recipe = signal<ExportRecipe>({ ...DEFAULT_EXPORT_RECIPE });
  readonly recipes = signal<ExportRecipe[]>([]);
  readonly storageError = signal<string | null>(null);
  readonly directoryName = signal<string | null>(null);
  readonly problem = computed(() => exportRecipeProblem(this.recipe()));
  readonly formats = EXPORT_ENCODERS.map((encoder) => ({
    value: encoder.format,
    label: `${encoder.format.toUpperCase()} ${encoder.bitDepth}-bit`,
  }));
  readonly profiles = [
    { value: 'srgb', label: 'sRGB' },
    { value: 'display-p3', label: 'Display P3' },
  ];
  readonly destinations = [
    { value: 'download', label: 'Browser downloads' },
    {
      value: 'directory',
      label: this.queue.serverAvailable ? 'Server directory' : 'Chosen folder',
    },
  ];
  readonly overwriteOptions = [
    { value: 'error', label: 'Stop for collision' },
    { value: 'skip', label: 'Skip existing' },
    { value: 'replace', label: 'Replace existing' },
  ];
  readonly sizes = [
    { value: 0, label: 'Full resolution' },
    { value: 2048, label: '2048 px' },
    { value: 4096, label: '4096 px' },
  ];
  readonly percent = computed(() => {
    const progress = this.queue.progress();
    return progress?.total ? (progress.processed / progress.total) * 100 : null;
  });
  readonly failures = computed(() => this.queue.summary()?.failed.slice(0, 5) ?? []);
  readonly resultText = computed(() => {
    const record = this.queue.record();
    if (!record) return null;
    const summary = this.queue.summary()!;
    const skipped = record.entries.filter((entry) => entry.status === 'skipped').length;
    const verb = record.recipe.destination === 'directory' ? 'saved' : 'submitted to Downloads';
    return `${summary.applied.length} ${verb} · ${skipped} skipped · ${summary.failed.length} failed · ${this.queue.remaining()} remaining`;
  });

  constructor() {
    effect(() => {
      if (this.visible()) void this.refreshRecipes();
    });
    effect(() => {
      const key = this.recipe().directory;
      this.directoryName.set(null);
      if (key && !this.queue.serverAvailable) {
        void readRecipeDirectory(key)
          .then((handle) => {
            if (this.recipe().directory === key) this.directoryName.set(handle?.name ?? null);
          })
          .catch((error: unknown) => this.storageError.set(String(error)));
      }
    });
  }
  patch(patch: Partial<ExportRecipe>): void {
    this.recipe.update((recipe) => ({ ...recipe, ...patch }));
  }
  setFormat(format: string): void {
    const encoder = EXPORT_ENCODERS.find((entry) => entry.format === format);
    if (encoder)
      this.patch({ format, bitDepth: encoder.bitDepth, quality: format === 'jpeg' ? 92 : null });
  }
  setDestination(destination: string): void {
    this.patch({
      destination,
      directory: destination === 'directory' ? '' : null,
      overwritePolicy: destination === 'directory' ? 'error' : 'browser',
    });
  }
  async chooseDirectory(): Promise<void> {
    try {
      const selected = await this.queue.directories.choose();
      this.patch({
        destination: 'directory',
        directory: selected.key,
        overwritePolicy:
          this.recipe().overwritePolicy === 'browser' ? 'error' : this.recipe().overwritePolicy,
      });
      this.directoryName.set(selected.name);
      this.storageError.set(null);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        this.storageError.set(String(error));
    }
  }
  async persist(): Promise<void> {
    try {
      await saveRecipe(this.recipe());
      await this.refreshRecipes();
    } catch (error) {
      this.storageError.set(String(error));
    }
  }
  async remove(name: string): Promise<void> {
    try {
      await deleteRecipe(name);
      await this.refreshRecipes();
    } catch (error) {
      this.storageError.set(String(error));
    }
  }
  download(): void {
    downloadBlob(
      new Blob([JSON.stringify(this.recipe(), null, 2)], { type: 'application/json' }),
      'maple-export-recipe.json',
    );
  }
  async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error('Recipe file exceeds 64 KB');
      this.recipe.set(parseExportRecipe(JSON.parse(await file.text())));
      this.storageError.set(null);
    } catch (error) {
      this.storageError.set(String(error));
    } finally {
      input.value = '';
    }
  }
  private async refreshRecipes(): Promise<void> {
    try {
      this.recipes.set(await savedRecipes());
      this.storageError.set(null);
    } catch (error) {
      this.storageError.set(String(error));
    }
  }
}
