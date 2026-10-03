import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import type { WhiteBalancePreset } from '../../projects/maple-common/src/lib/generated/white-balance-presets.generated';
import { AdjustmentClipboardService } from '../../projects/maple-common/src/lib/editor/copy-paste/adjustment-clipboard.service';
import { BatchSyncService } from '../../projects/maple-common/src/lib/editor/copy-paste/batch-sync.service';
import {
  buildTransferPatch,
  type AdjustmentTransferRequest,
} from '../../projects/maple-common/src/lib/editor/copy-paste/adjustment-transfer';

/** Shipping editor, folder persistence, RAW worker and export; no substitutes. */
export async function whiteBalanceWorkflow(mode: WhiteBalancePreset | 'Sampled') {
  const app = await createApplication({
    providers: [provideHostedWorkspace(), provideHttpClient(withFetch()), provideRouter([])],
  });
  const root = await navigator.storage.getDirectory();
  const name = 'maple-wb-workflow-' + crypto.randomUUID();
  const native = await root.getDirectoryHandle(name, { create: true });
  const folder = { native, name, read: true, write: true };
  try {
    const access = app.injector.get(FolderAccessService);
    const serializer = app.injector.get(XmpSerializerService);
    const parser = app.injector.get(XmpParserService);
    const input = serializer.serialize({
      ...defaultAdjustmentModel(),
      whiteBalancePreset: mode === 'Custom' ? 'As Shot' : 'Custom',
      wbSource: mode === 'Custom' ? 'AsShot' : 'Manual',
      temperature: 4800,
      tint: 8,
    });
    const fixture = await fetch('/workflow-fixture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml: input, synthetic: true }),
    }).then((r) => r.json());
    const original = await fetch('/workflow-fixture/' + fixture.key).then((r) => r.json());
    const bytes = new Uint8Array(original.original);
    await access.writeFile(folder, 'photo.dng', bytes);
    await access.writeFile(folder, 'copy.dng', bytes);
    await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
    const library = app.injector.get(LibraryStateService);
    const writer = app.injector.get(XmpStoreService);
    const editor = app.injector.get(EditorStateService);
    const pipeline = app.injector.get(RawPipelineService);
    app.injector.get(GpuLiveRenderGate).apply(false);
    await library.openFolder(folder);
    const id = library.assets().find((asset) => asset.filename === 'photo.dng')!.id;
    library.focusedAssetId.set(id);
    editor.bind(id);
    const camera = await pipeline.decode(bytes, 'dng', '', 64, true);
    library.seedAsShotWhiteBalance(id, camera.asShotTemperature, camera.asShotTint);
    const before = JSON.stringify(library.adjustmentFor(id)());
    const changed =
      mode === 'Sampled'
        ? await editor.sampleWhiteBalanceAt(id, 0.25, 0.75)
        : await editor.applyWhiteBalancePreset(id, mode);
    await writer.settleAsset(id);
    const applied = JSON.stringify(library.adjustmentFor(id)());
    const saved = new TextDecoder().decode(await access.readFile(folder, 'photo.xmp'));
    const exportPixels = async (xml: string) => {
      const output = await pipeline.exportImage(
        bytes,
        'dng',
        { format: 'png', quality: 100, colorSpace: 'srgb' },
        xml,
      );
      const bitmap = await createImageBitmap(output.blob);
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        return JSON.stringify([...context.getImageData(0, 0, bitmap.width, bitmap.height).data]);
      } finally {
        bitmap.close();
      }
    };
    const exported = await exportPixels(saved);
    editor.undo();
    await writer.settleAsset(id);
    const undone = JSON.stringify(library.adjustmentFor(id)()) === before;
    editor.redo();
    await writer.settleAsset(id);
    const redone = JSON.stringify(library.adjustmentFor(id)()) === applied;
    const restored = new TextDecoder().decode(await access.readFile(folder, 'photo.xmp'));
    const redoExport = await exportPixels(restored);
    await library.openFolder(folder);
    editor.bind(id);
    const reopened = serializer.serialize(library.adjustmentFor(id)());
    const clipboard = app.injector.get(AdjustmentClipboardService);
    clipboard.copyFrom(id, 'photo.dng', library.adjustmentFor(id)());
    const request: AdjustmentTransferRequest = {
      sourceAssetId: clipboard.entry()!.sourceAssetId,
      source: clipboard.entry()!.model,
      groups: ['white_balance'],
      relativeWhiteBalance: false,
    };
    const targetId = library.assets().find((asset) => asset.filename === 'copy.dng')!.id;
    const batch = app.injector.get(BatchSyncService);
    const summary = await batch.apply([targetId], buildTransferPatch(request), request);
    if (!summary || summary.failed.length)
      throw new Error(batch.error() ?? JSON.stringify(summary));
    const copied = new TextDecoder().decode(await access.readFile(folder, 'copy.xmp'));
    return {
      changed,
      undone,
      redone,
      roundtrip:
        JSON.stringify(parser.parseAdjustmentModel(reopened).model) ===
        JSON.stringify(parser.parseAdjustmentModel(saved).model),
      redoPixels: redoExport === exported,
      reopenPixels: (await exportPixels(reopened)) === exported,
      copyApplied: summary.applied.length === 1 && summary.applied[0] === targetId,
      copyPixels: (await exportPixels(copied)) === exported,
      copyOriginalUnchanged: (await access.readFile(folder, 'copy.dng')).every(
        (v, i) => v === bytes[i],
      ),
      originalUnchanged: (await access.readFile(folder, 'photo.dng')).every(
        (v, i) => v === bytes[i],
      ),
      model: parser.parseAdjustmentModel(saved).model,
      copiedModel: parser.parseAdjustmentModel(copied).model,
    };
  } finally {
    app.destroy();
    await root.removeEntry(name, { recursive: true });
  }
}
