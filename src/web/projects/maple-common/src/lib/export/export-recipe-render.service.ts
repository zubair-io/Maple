import { RecipeFilenameEngine } from './recipe-filename-engine';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { LibraryStore } from '../state/library-store.service';
import { BatchPreviewService } from '../editor/copy-paste/batch-preview.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { FilmLutService } from '../film/film-lut.service';
import {
  exportRecipeProblem,
  exportCaptureTime,
  type ExportRecipe,
} from '../generated/export-recipe.generated';
import type { Asset } from '../models/asset';
import type {
  ExportColorSpace,
  ExportFormat,
  ExportedFile,
} from '../raw-pipeline/raw-pipeline.types';
import type { RecipeTarget } from './export-recipe-store';
import { extensionOf } from './image-export.service';

@Injectable({ providedIn: 'root' })
export class ExportRecipeRenderService {
  private readonly library = inject(LibraryStateService);
  private readonly store = inject(LibraryStore);
  private readonly preview = inject(BatchPreviewService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly xmp = inject(XmpStoreService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly films = inject(FilmLutService);

  async capture(assets: readonly Asset[]): Promise<RecipeTarget[]> {
    if (!assets.length || assets.length > 2000)
      throw new Error('Select between 1 and 2,000 photos');
    const models = await this.preview.readTargets(assets.map((asset) => asset.id));
    return assets.map((asset, index) => ({
      id: asset.id,
      filename: asset.filename,
      path: this.store.absPathFor(asset.id) ?? null,
      xmp: this.serializer.serialize(models[index], this.xmp.passthroughFor(asset.id)),
      filmLook: models[index].filmLook,
      capturedAt: exportCaptureTime(asset.capturedAt ?? null),
      index,
    }));
  }

  private readonly names = new RecipeFilenameEngine();
  constructor() {
    inject(DestroyRef).onDestroy(() => this.names.close());
  }
  filename(target: RecipeTarget, recipe: ExportRecipe): Promise<string> {
    return this.names.name(target, recipe);
  }

  async render(target: RecipeTarget, recipe: ExportRecipe): Promise<ExportedFile> {
    const problem = exportRecipeProblem(recipe);
    if (problem) throw new Error(problem);
    const film = target.filmLook ? await this.films.getLattice(target.filmLook) : null;
    if (target.filmLook && !film)
      throw new Error(`Film look ${target.filmLook} is unavailable. Reconnect and retry.`);
    const source = target.sourceHandle
      ? target.sourceHandle.getFile().then(async (file) => new Uint8Array(await file.arrayBuffer()))
      : this.library.bytesForAsset(target.id);
    const bytes = await source.catch((error: unknown) => {
      throw new Error(
        `Reopen the source folder and retry ${target.filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.pipeline.exportImage(
      bytes,
      extensionOf(target.filename),
      {
        format: recipe.format as ExportFormat,
        quality: recipe.quality ?? 100,
        colorSpace: recipe.outputProfile as ExportColorSpace,
        maxSidePixels: recipe.maxLongEdge ?? undefined,
      },
      target.xmp,
      film ?? undefined,
    );
  }
}
