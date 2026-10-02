import { Injectable, inject } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { XmpCulling } from '../xmp/xmp.types';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { LibraryStore } from '../state/library-store.service';
import { SidecarStore } from '../xmp/sidecar.store';
import { SelfHostedWorkflowWriterService } from '../xmp/self-hosted-workflow-writer.service';

interface WorkflowEditSource {
  readonly id: AssetId;
  readonly filename: string;
  readonly model: AdjustmentModel;
  readonly culling: XmpCulling;
  readonly cullingPatch: Readonly<Partial<XmpCulling>>;
}

export interface HostedWorkflowEdit extends WorkflowEditSource {
  readonly backend: 'hosted';
  readonly folder: MapleFolderHandle;
}
export interface SelfHostedWorkflowEdit extends WorkflowEditSource {
  readonly backend: 'self-hosted';
  readonly path: string;
}
export type WorkflowEdit = HostedWorkflowEdit | SelfHostedWorkflowEdit;

/** Capture the actual source at the gesture boundary; navigation cannot redirect its save. */
@Injectable({ providedIn: 'root' })
export class EditorWorkflowHistoryService {
  private readonly library = inject(LibraryStore);
  private readonly writer = inject(XmpStoreService);
  private readonly server: SidecarStore | null =
    this.library.backend === 'self-hosted' ? inject(SidecarStore) : null;
  private readonly serverWriter: SelfHostedWorkflowWriterService | null =
    this.library.backend === 'self-hosted' ? inject(SelfHostedWorkflowWriterService) : null;

  capture(id: AssetId, model: AdjustmentModel): WorkflowEdit | null {
    const asset = this.library.findAsset(id);
    if (!asset) return null;
    const folder = this.library.currentFolder();
    const path = this.library.absPathFor(id);
    const source =
      this.library.backend === 'self-hosted'
        ? path
          ? { backend: 'self-hosted' as const, path }
          : null
        : folder?.native && folder.write
          ? { backend: 'hosted' as const, folder }
          : null;
    if (!source) return null;
    // Copied single-file imports have no writable source and remain #2437.
    return {
      ...source,
      id,
      filename: asset.filename,
      model: structuredClone(model),
      cullingPatch: this.library.cullingPatchFor(id),
      culling: {
        rating: asset.rating,
        flag: asset.flag,
        colorLabel: asset.colorLabel,
        keywords: [...(asset.keywords ?? [])],
      },
    };
  }

  isCurrent(edit: WorkflowEdit): boolean {
    return (
      (edit.backend === 'hosted'
        ? this.library.currentFolder() === edit.folder
        : this.library.absPathFor(edit.id) === edit.path) &&
      this.library.findAsset(edit.id)?.filename === edit.filename
    );
  }

  model(edit: WorkflowEdit, live: AdjustmentModel | null): AdjustmentModel {
    return this.isCurrent(edit) && live
      ? live
      : edit.backend === 'hosted'
        ? (this.writer.latestModel(edit.id, edit.folder) ?? edit.model)
        : (this.serverWriter?.latestModel(edit.path) ?? edit.model);
  }

  record(edit: WorkflowEdit, model: AdjustmentModel, action: string, label: string): void {
    const kind = ['preset', 'paste', 'reset', 'undo', 'redo'].includes(action)
      ? action
      : 'adjustment';
    if (edit.backend === 'self-hosted') {
      if (!this.server) throw Error('Self Hosted sidecar persistence is not configured');
      void this.server
        .commitSemantic(edit.id, edit.path, {
          before: edit.model,
          after: model,
          culling: edit.culling,
          cullingPatch: this.isCurrent(edit)
            ? this.library.cullingPatchFor(edit.id)
            : edit.cullingPatch,
          action: kind,
          label,
        })
        .catch(() => undefined);
      return;
    }
    // Publication errors are surfaced by SidecarSaveState; flush retries the captured action.
    void this.writer
      .commitSemantic(edit.id, edit.folder, edit.filename, model, edit.culling, kind, label)
      .catch(() => undefined);
  }
}
