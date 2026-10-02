import { Injectable, inject } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { XmpCulling } from '../xmp/xmp.types';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { LibraryStore } from '../state/library-store.service';

export interface HostedWorkflowEdit {
  readonly id: AssetId;
  readonly folder: MapleFolderHandle;
  readonly filename: string;
  readonly model: AdjustmentModel;
  readonly culling: XmpCulling;
}

/** Capture the actual source at the gesture boundary; navigation cannot redirect its save. */
@Injectable({ providedIn: 'root' })
export class EditorWorkflowHistoryService {
  private readonly library = inject(LibraryStore);
  private readonly writer = inject(XmpStoreService);

  capture(id: AssetId, model: AdjustmentModel): HostedWorkflowEdit | null {
    const asset = this.library.findAsset(id);
    const folder = this.library.currentFolder();
    // Self Hosted transactions/indexing and single-file imports remain #2437.
    if (this.library.backend !== 'hosted' || !asset || !folder?.native || !folder.write)
      return null;
    return {
      id,
      folder,
      filename: asset.filename,
      model: structuredClone(model),
      culling: {
        rating: asset.rating,
        flag: asset.flag,
        colorLabel: asset.colorLabel,
        keywords: [...(asset.keywords ?? [])],
      },
    };
  }

  isCurrent(edit: HostedWorkflowEdit): boolean {
    return (
      this.library.currentFolder() === edit.folder &&
      this.library.findAsset(edit.id)?.filename === edit.filename
    );
  }

  model(edit: HostedWorkflowEdit, live: AdjustmentModel | null): AdjustmentModel {
    return this.isCurrent(edit) && live
      ? live
      : (this.writer.latestModel(edit.id, edit.folder) ?? edit.model);
  }

  record(edit: HostedWorkflowEdit, model: AdjustmentModel, action: string, label: string): void {
    const kind = ['preset', 'paste', 'reset', 'undo', 'redo'].includes(action)
      ? action
      : 'adjustment';
    // Publication errors are surfaced by SidecarSaveState; flush retries the captured action.
    void this.writer
      .commitSemantic(edit.id, edit.folder, edit.filename, model, edit.culling, kind, label)
      .catch(() => undefined);
  }
}
