import { Injectable, inject } from '@angular/core';
import { LibraryStore } from '../state/library-store.service';
import { XmpStoreService } from './xmp-store.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { PRIMARY_VARIANT_ID } from '../generated/workflow.generated';

export interface WorkflowVariantSelection {
  readonly scope: string | MapleFolderHandle | null;
  readonly variantId: string;
}

@Injectable({ providedIn: 'root' })
export class WorkflowVariantSelectionService {
  private readonly library = inject(LibraryStore);
  private readonly writer = inject(XmpStoreService);

  current(id: string): WorkflowVariantSelection {
    if (this.library.backend === 'self-hosted') {
      const path = this.library.absPathFor(id);
      return {
        scope: path ?? null,
        variantId: path ? this.library.workflowVariants.variantFor(id, path) : PRIMARY_VARIANT_ID,
      };
    }
    const folder = this.library.currentFolder();
    const asset = this.library.findAsset(id);
    return {
      scope: folder,
      variantId:
        folder && asset
          ? this.writer.bindingFor(id, folder, asset.filename).variantId
          : PRIMARY_VARIANT_ID,
    };
  }
}
