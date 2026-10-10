import { signal } from '@angular/core';
import type { RemovalCompanionBundle } from '../removal/removal-companion-bundle';
import { dispatchExport } from './raw-pipeline.export-request';
import type { PendingHandler } from './raw-pipeline.service-internals';
import type { ExportedFile, RawExportOptions } from './raw-pipeline.types';

/** Own full-resolution export dispatch and its source-rebind revision. */
export class RawPipelineExportClient {
  readonly revision = signal(0);

  constructor(
    private readonly worker: () => Worker,
    private readonly nextId: () => number,
    private readonly pending: Map<number, PendingHandler>,
    private readonly enqueue: <T>(run: () => Promise<T>) => Promise<T>,
    private readonly closeNativeDetail: () => void,
  ) {}

  exportImage(
    bytes: Uint8Array,
    ext: string,
    options: RawExportOptions,
    xmp?: string,
    filmLut?: ArrayBuffer,
    saved?: RemovalCompanionBundle,
  ): Promise<ExportedFile> {
    const run = () => {
      this.closeNativeDetail();
      return this.exportOnce(bytes, ext, options, xmp, filmLut, saved);
    };
    return this.enqueue(run).finally(() => this.revision.update((value) => value + 1));
  }

  private exportOnce(
    bytes: Uint8Array,
    ext: string,
    options: RawExportOptions,
    xmp: string | undefined,
    filmLut: ArrayBuffer | undefined,
    saved: RemovalCompanionBundle | undefined,
  ): Promise<ExportedFile> {
    let worker: Worker;
    try {
      worker = this.worker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    return dispatchExport(
      worker,
      this.nextId(),
      (id, handler) => this.pending.set(id, handler),
      bytes,
      ext,
      options,
      xmp,
      filmLut,
      saved,
    );
  }
}
