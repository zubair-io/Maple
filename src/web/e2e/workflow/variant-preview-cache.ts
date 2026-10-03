import { createApplication } from '@angular/platform-browser';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
import { imageDataToBitmap } from '../../projects/maple-common/src/lib/raw-pipeline/image-utils';
import { ImageCanvasVariantPreviews } from '../../projects/maple-common/src/lib/components/image-canvas/image-canvas.variant-previews';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { WorkflowVariantStoreService } from '../../projects/maple-common/src/lib/xmp/workflow-variant-store.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';

/** Real RAW/WASM pixels and owned OPFS sidecars; no render or sidecar substitutes. */
export async function variantPreviewCache() {
  const app = await createApplication({ providers: [provideHostedWorkspace()] });
  const root = await navigator.storage.getDirectory();
  const directory = 'maple-render-variants-' + crypto.randomUUID();
  const native = await root.getDirectoryHandle(directory, { create: true });
  const folder = { native, name: directory, read: true, write: true };
  const cache = new ImageCanvasVariantPreviews();
  const bitmaps: ImageBitmap[] = [];
  try {
    // Exercise the shipping CPU fallback, with its real worker and RAW cache.
    app.injector.get(GpuLiveRenderGate).apply(false);
    const serializer = app.injector.get(XmpSerializerService);
    const input = serializer.serialize(defaultAdjustmentModel());
    const receipt = await fetch('/workflow-fixture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml: input, synthetic: true }),
    }).then((response) => response.json());
    const original = await fetch('/workflow-fixture/' + receipt.key).then((response) =>
      response.json(),
    );
    const bytes = new Uint8Array(original.original);
    const access = app.injector.get(FolderAccessService);
    await access.writeFile(folder, 'photo.dng', bytes);
    await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
    const variants = app.injector.get(WorkflowVariantStoreService);
    const selected = [];
    const exported: ImageBitmap[] = [];
    for (let index = 0; index < 3; index++) {
      const variantId = crypto.randomUUID();
      await variants.create(folder, 'photo.xmp', {
        schemaVersion: 1,
        variantId,
        variantName: 'Exposure ' + index,
        snapshots: [],
        history: [],
      });
      const xmp = serializer.serialize({ ...defaultAdjustmentModel(), exposure: index * 1.5 });
      await variants.write(folder, 'photo.xmp', variantId, xmp);
      const confirmed = await variants.read(folder, 'photo.xmp', variantId);
      const pixels = await app.injector
        .get(RawPipelineService)
        .decode(bytes, 'dng', confirmed!, 64, true);
      const bitmap = await imageDataToBitmap(pixels);
      const file = await app.injector
        .get(RawPipelineService)
        .exportImage(bytes, 'dng', { format: 'png', quality: 100, colorSpace: 'srgb' }, confirmed!);
      const output = await createImageBitmap(file.blob);
      exported.push(output);
      bitmaps.push(output);
      bitmaps.push(bitmap);
      selected.push({
        selection: { scope: folder, variantId },
        id: 'photo',
        bytes,
        width: 64,
        xmp,
        bitmap,
      });
    }
    const canvas = new OffscreenCanvas(selected[0].bitmap.width, selected[0].bitmap.height);
    const context = canvas.getContext('2d')!;
    const readPixel = (bitmap: ImageBitmap) => {
      context.drawImage(bitmap, 0, 0);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const renderedDifferent = readPixel(selected[0].bitmap).some(
      (value, index) => value !== readPixel(selected[1].bitmap)[index],
    );
    const exportDifferent = readPixel(exported[0]).some(
      (value, index) => value !== readPixel(exported[1])[index],
    );
    exported.forEach((bitmap) => bitmap.close());
    cache.store(selected[0]);
    cache.store(selected[1]);
    const staleXML = cache.take({ ...selected[0], xmp: selected[1].xmp }) === null;
    const staleBytes = cache.take({ ...selected[0], bytes: bytes.slice() }) === null;
    const staleViewport = cache.take({ ...selected[0], width: 128 }) === null;
    const hit = cache.take(selected[0]);
    const reuseExactBitmap = hit === selected[0].bitmap;
    cache.store(selected[0]);
    cache.store(selected[2]);
    const oldestClosed = selected[1].bitmap.width === 0;
    cache.clear();
    const allClosed = bitmaps.every((bitmap) => bitmap.width === 0);
    return {
      renderedDifferent,
      exportDifferent,
      staleXML,
      staleBytes,
      staleViewport,
      reuseExactBitmap,
      oldestClosed,
      allClosed,
      primaryUnchanged:
        new TextDecoder().decode(await access.readFile(folder, 'photo.xmp')) === input,
      originalUnchanged:
        bytes.every((value, index) => value === original.original[index]) &&
        (await access.readFile(folder, 'photo.dng')).every(
          (value, index) => value === bytes[index],
        ),
      rawLength: bytes.length,
    };
  } finally {
    cache.clear();
    bitmaps.forEach((bitmap) => bitmap.close());
    app.destroy();
    await root.removeEntry(directory, { recursive: true });
  }
}
