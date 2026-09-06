import { Injectable, Injector, inject } from '@angular/core';
import { LibraryStore } from '../../state/library-store.service';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SERVER_WORKSPACE_PERSISTENCE } from '../../workspace/workspace-persistence';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

@Injectable({ providedIn: 'root' })
export class BatchPreviewService {
  private readonly injector = inject(Injector);
  // Resolved through Injector after a dynamic import from BrowseShell.
  // fallow-ignore-next-line unused-class-member
  async baseline(id: string) {
    const { BatchSyncAssetIO } = await import('./batch-sync-asset-io.service');
    return this.injector.get(BatchSyncAssetIO).baseline(id);
  }

  private readonly store = inject(LibraryStore);
  private readonly persistence = inject(SERVER_WORKSPACE_PERSISTENCE, { optional: true });
  private readonly parser = inject(XmpParserService);

  async readPersisted(id: string): Promise<AdjustmentModel> {
    const path = this.store.absPathFor(id);
    if (!path || !this.persistence) throw new Error(`Cannot resolve the sidecar for ${id}`);
    try {
      const xml = await firstValueFrom(this.persistence.readSidecar(path));
      if (
        xml &&
        new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror')
      ) {
        throw new Error(`The sidecar for ${id} is not valid XML`);
      }
      return {
        ...defaultAdjustmentModel(),
        ...(xml ? this.parser.parseAdjustmentModel(xml).model : {}),
      };
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 404)
        return defaultAdjustmentModel();
      throw error;
    }
  }

  /** Bounded reads. A cold Self Hosted target must never be presented as defaults. */
  async readTargets(ids: readonly string[]): Promise<readonly AdjustmentModel[]> {
    const targets: AdjustmentModel[] = [];
    for (let offset = 0; offset < ids.length; offset += 8) {
      targets.push(
        ...(await Promise.all(
          ids.slice(offset, offset + 8).map(async (id) => {
            const current = this.store.adjustmentModels().get(id);
            if (current) return structuredClone(current);
            if (this.store.backend !== 'self-hosted') {
              const { BatchSyncAssetIO } = await import('./batch-sync-asset-io.service');
              return this.injector.get(BatchSyncAssetIO).model(id);
            }
            return this.readPersisted(id);
          }),
        )),
      );
    }
    return targets;
  }
}
