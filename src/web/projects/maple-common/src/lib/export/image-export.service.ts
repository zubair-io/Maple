// ImageExportService — render the current edit to a deliverable file (#943).
//
// Orchestration only. The render and the encode both happen inside the WASM
// module (see `raw-wasm::export_bytes`), which is what lets an export share
// the display pipeline byte-for-byte and keeps a full-resolution buffer off
// the JS heap.
//
// ## Why in the browser rather than on the API
//
// The editor already holds the RAW bytes — that is how the canvas is rendered
// — so exporting in the browser reuses the pipeline that produced the picture
// the user approved. A server render endpoint could not serve the Hosted
// deployment at all: there the library sits behind a File System Access
// handle and the server never sees the files, so the RAW would have to be
// uploaded first. One in-browser path works identically in Hosted and
// Self-Hosted.

import { Injectable, inject } from '@angular/core';
import type { AssetId, Asset } from '../models/asset';
import { LibraryStateService } from '../state/library-state.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { ExportedFile, RawExportOptions } from '../raw-pipeline/raw-pipeline.types';
import { downloadBlob } from './download-blob';
import { exportFilename, lastSegment } from './export-dialog.vm';

/** What an export produced, for the caller to report. */
export interface ExportOutcome {
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

@Injectable({ providedIn: 'root' })
export class ImageExportService {
  private readonly library = inject(LibraryStateService);
  private readonly xmpStore = inject(XmpStoreService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly pipeline = inject(RawPipelineService);

  /**
   * Render `asset` under its current adjustments and download the result.
   *
   * The sidecar is refreshed first, so the `.xmp` next to the original always
   * describes the edit the exported file was rendered from. That write goes
   * through the existing XMP layer, which already routes correctly for both
   * deployments; the exported image itself is handed to the browser's download
   * location and never written into the library. Originals are untouched.
   */
  async exportAsset(asset: Asset, options: RawExportOptions): Promise<ExportOutcome> {
    const xmp = this.sidecarXml(asset);
    const bytes = await this.library.bytesForAsset(asset.id);
    const file = await this.pipeline.exportImage(bytes, extensionOf(asset.filename), options, xmp);
    await this.persistSidecar(asset.id);
    return this.deliver(asset, file);
  }

  /**
   * Serialize the current in-memory adjustments to sidecar XML.
   *
   * This is the exact text handed to the renderer, so the exported pixels come
   * from the same adjustments the sidecar records — not from a separately
   * assembled model that could drift from it.
   */
  private sidecarXml(asset: Asset): string {
    const model = this.library.adjustmentFor(asset.id)();
    const culling = {
      rating: asset.rating,
      flag: asset.flag,
      colorLabel: asset.colorLabel,
      keywords: asset.keywords ?? [],
    };
    return this.serializer.serialize(model, this.xmpStore.passthroughFor(asset.id), culling);
  }

  /**
   * Flush the sidecar for `id` now rather than on the usual 750ms debounce, so
   * a user who exports and immediately leaves still has the `.xmp` on disk.
   *
   * A sidecar write failure must not fail the export — the rendered file is
   * already correct and is the thing the user asked for — so this reports and
   * continues.
   */
  private async persistSidecar(id: AssetId): Promise<void> {
    try {
      this.library.scheduleSidecarWrite(id);
      await this.library.flushPendingXmpWrites();
    } catch (err) {
      console.error('[export] sidecar write failed; the exported file is unaffected:', err);
    }
  }

  private deliver(asset: Asset, file: ExportedFile): ExportOutcome {
    const filename = exportFilename(asset.filename, file.extension);
    downloadBlob(file.blob, filename);
    return {
      filename,
      width: file.width,
      height: file.height,
      byteLength: file.blob.size,
    };
  }
}

/** Lowercase extension of a filename, or `''` when it has none. */
export function extensionOf(filename: string): string {
  const last = lastSegment(filename);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}
