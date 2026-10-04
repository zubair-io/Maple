import { createComponent, type ApplicationRef, type ComponentRef } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { RecipeExportDialogComponent } from '../../projects/maple-common/src/lib/export/recipe-export-dialog/recipe-export-dialog.component';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { ExportRecipeQueueService } from '../../projects/maple-common/src/lib/export/export-recipe-queue.service';
import { saveRecipeDirectory } from '../../projects/maple-common/src/lib/export/export-recipe-store';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { DEFAULT_EXPORT_RECIPE } from '../../projects/maple-common/src/lib/generated/export-recipe.generated';
import type {
  ExportFormat,
  ExportColorSpace,
} from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types';

const filename = 'test_0007.DNG';
let active: {
  app: ApplicationRef;
  component: ComponentRef<RecipeExportDialogComponent>;
  host: HTMLElement;
  source: FileSystemDirectoryHandle;
  output: FileSystemDirectoryHandle;
} | null = null;
async function hash(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
async function dispose() {
  if (!active) return;
  active.app.destroy();
  active.host.remove();
  active = null;
}
Object.assign(window, {
  recipeQualityUI: {
    ready: true,
    async mount(name?: string) {
      await dispose();
      const app = await createApplication({
        providers: [provideHostedWorkspace(), provideHttpClient(withFetch()), provideRouter([])],
      });
      const host = document.createElement('div');
      try {
        const root = await navigator.storage.getDirectory();
        const key = name ?? 'maple-recipe-quality-' + crypto.randomUUID();
        const source = await root.getDirectoryHandle(key, { create: true });
        const output = await root.getDirectoryHandle(key + '-outputs', { create: true });
        const folder = { native: source, name: key, read: true, write: true };
        if (!name) {
          const response = await fetch('/physical-raw/' + filename);
          if (!response.ok) throw Error('Physical recipe RAW fixture is missing');
          await app.injector
            .get(FolderAccessService)
            .writeFile(folder, filename, new Uint8Array(await response.arrayBuffer()));
        }
        const library = app.injector.get(LibraryStateService);
        await library.openFolder(folder);
        const asset = library.assets().find((a) => a.filename === filename);
        if (!asset) throw Error('Physical recipe asset was not indexed');
        document.body.append(host);
        const component = createComponent(RecipeExportDialogComponent, {
          environmentInjector: app.injector,
          hostElement: host,
        });
        component.setInput('visible', true);
        component.setInput('assets', [asset]);
        component.instance.patch({
          destination: 'directory',
          directory: await saveRecipeDirectory(output),
          overwritePolicy: 'error',
          maxLongEdge: 512,
        });
        app.attachView(component.hostView);
        component.changeDetectorRef.detectChanges();
        active = { app, component, host, source, output };
        return key;
      } catch (error) {
        app.destroy();
        host.remove();
        throw error;
      }
    },
    state() {
      if (!active) throw Error('Recipe qualification is not mounted');
      const queue = active.app.injector.get(ExportRecipeQueueService);
      return {
        recipe: active.component.instance.recipe(),
        saved: active.component.instance.recipes(),
        record: queue.record(),
        summary: queue.summary(),
        running: queue.running(),
        error: queue.error(),
        storageError: active.component.instance.storageError(),
      };
    },
    async outputProof() {
      if (!active) throw Error('Recipe qualification is not mounted');
      const record = active.app.injector.get(ExportRecipeQueueService).record();
      if (!record || record.entries[0].status !== 'applied')
        throw Error('Actual recipe output is not applied');
      const source = await (await active.source.getFileHandle(filename)).getFile();
      const output = await (
        await active.output.getFileHandle(record.entries[0].filename!)
      ).getFile();
      const recipe = record.recipe;
      const target = record.targets[0];
      const reference = await active.app.injector.get(RawPipelineService).exportImage(
        new Uint8Array(await source.arrayBuffer()),
        'dng',
        {
          format: recipe.format as ExportFormat,
          quality: recipe.quality ?? DEFAULT_EXPORT_RECIPE.quality!,
          colorSpace: recipe.outputProfile as ExportColorSpace,
          maxSidePixels: recipe.maxLongEdge ?? undefined,
        },
        target.xmp,
      );
      const alternate =
        recipe.format === 'webp'
          ? null
          : await active.app.injector.get(RawPipelineService).exportImage(
              new Uint8Array(await source.arrayBuffer()),
              'dng',
              {
                format: recipe.format as ExportFormat,
                quality: 1,
                colorSpace: recipe.outputProfile as ExportColorSpace,
                maxSidePixels: recipe.maxLongEdge ?? undefined,
              },
              target.xmp,
            );
      const bitmap = await createImageBitmap(output);
      try {
        return {
          sourceHash: await hash(await source.arrayBuffer()),
          outputHash: await hash(await output.arrayBuffer()),
          referenceHash: await hash(await reference.blob.arrayBuffer()),
          alternateHash: alternate ? await hash(await alternate.blob.arrayBuffer()) : null,
          bytes: output.size,
          width: bitmap.width,
          height: bitmap.height,
          quality: recipe.quality,
        };
      } finally {
        bitmap.close();
      }
    },
    dispose,
  },
});
