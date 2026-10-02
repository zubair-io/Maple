// Imperative confirmed-save coordinator, shared by authoring and history (#3984).
import type { Injector } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LibraryStateService } from '../state/library-state.service';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling } from '../xmp/xmp.types';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { SidecarStore } from '../xmp/sidecar.store';
import { XmpAdjustmentRestoreService } from '../xmp/xmp-adjustment-restore.service';
import { SidecarSaveStateService } from '../xmp/sidecar-save-state.service';
import { RemovalServerIoService } from './removal-server-io.service';
import { withRemovalRecords } from './removal-editor-recipe';
import { confirmedSidecarRevision } from './removal-server-confirmation';

export class ServerRemovalSidecars {
  constructor(
    private readonly library: LibraryStateService,
    private readonly injector: Injector,
  ) {}

  async capture(id: string) {
    await this.library.settleSidecarWrites(id);
    const path = this.path(id);
    const snapshot = await firstValueFrom(this.injector.get(RemovalServerIoService).snapshot(path));
    return { path, ...snapshot };
  }

  async write(
    id: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    expectedRecords: string,
    records: string,
    expectedRevision?: string,
  ): Promise<string> {
    const state = this.injector.get(SidecarSaveStateService);
    const sequence = state.queued(id);
    state.saving(id, sequence);
    try {
      const snapshot = await this.capture(id);
      const parser = this.injector.get(XmpParserService);
      const parsed = snapshot.xml ? parser.parseAdjustmentModel(snapshot.xml) : undefined;
      const sidecars = this.injector.get(XmpStoreService);
      const xml = this.injector
        .get(XmpSerializerService)
        .serialize(
          { ...model, inpaintRemovals: records },
          withRemovalRecords(parsed?.passthrough, records),
          culling,
          parsed ? undefined : sidecars.metadataFor(id),
        );
      const saved = await firstValueFrom(
        this.injector
          .get(RemovalServerIoService)
          .commit(snapshot.path, expectedRevision ?? snapshot.revision, expectedRecords, xml),
      );
      const revision = await confirmedSidecarRevision(xml, saved);
      // Never publish cached/ring state before the server confirms all bytes.
      await this.injector.get(SidecarStore).rememberConfirmed(snapshot.path, xml, revision);
      this.injector.get(XmpAdjustmentRestoreService).rememberConfirmed(id, xml);
      state.saved(id, sequence);
      return revision;
    } catch (error) {
      state.failed(id, sequence, error);
      throw error;
    }
  }

  private path(id: string): string {
    const path = this.library.absPathFor(id);
    if (!path) throw new Error('The server RAW path is unavailable. Reopen the photo.');
    return path;
  }
}
