import { Injectable, inject } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { XmpCulling } from '../xmp/xmp.types';
import { XmpStoreService, type HostedSidecarBinding } from '../xmp/xmp-store.service';
import { LibraryStore } from '../state/library-store.service';
import { SidecarStore } from '../xmp/sidecar.store';
import { SelfHostedWorkflowWriterService } from '../xmp/self-hosted-workflow-writer.service';

interface WorkflowEditSource {
  readonly id: AssetId;
  readonly filename: string;
  readonly model: AdjustmentModel;
  readonly culling: XmpCulling;
  readonly cullingPatch: Readonly<Partial<XmpCulling>>;
  readonly variantId: string;
}

export interface HostedWorkflowEdit extends WorkflowEditSource {
  readonly backend: 'hosted';
  readonly folder: MapleFolderHandle;
  readonly binding: HostedSidecarBinding;
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
    const source = this.source(id);
    if (!source) return null;
    const frozenSource =
      source.backend === 'hosted'
        ? { ...source, binding: this.writer.bindingFor(id, source.folder, asset.filename) }
        : source;
    const variantId =
      frozenSource.backend === 'hosted'
        ? frozenSource.binding.variantId
        : this.library.workflowVariants.variantFor(id, frozenSource.path);
    if (frozenSource.backend === 'self-hosted')
      this.serverWriter?.beginModel(frozenSource.path, model, variantId);
    // Copied single-file imports have no writable source and remain #2437.
    return {
      ...frozenSource,
      id,
      filename: asset.filename,
      variantId,
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

  private source(
    id: AssetId,
  ):
    | Pick<HostedWorkflowEdit, 'backend' | 'folder'>
    | Pick<SelfHostedWorkflowEdit, 'backend' | 'path'>
    | null {
    if (this.library.backend === 'self-hosted') {
      const path = this.library.absPathFor(id);
      return path ? { backend: 'self-hosted', path } : null;
    }
    const folder = this.library.currentFolder();
    return folder?.native && folder.write ? { backend: 'hosted', folder } : null;
  }

  isCurrent(edit: WorkflowEdit): boolean {
    return (
      (edit.backend === 'hosted'
        ? this.library.currentFolder() === edit.folder
        : this.library.absPathFor(edit.id) === edit.path) &&
      this.library.findAsset(edit.id)?.filename === edit.filename &&
      (edit.backend === 'hosted'
        ? this.writer.bindingFor(edit.id, edit.folder, edit.filename).variantId === edit.variantId
        : this.library.workflowVariants.variantFor(edit.id, edit.path) === edit.variantId)
    );
  }

  model(edit: WorkflowEdit, live: AdjustmentModel | null): AdjustmentModel {
    return this.isCurrent(edit) && live
      ? live
      : edit.backend === 'hosted'
        ? (this.writer.latestModel(edit.id, edit.folder, edit.variantId) ?? edit.model)
        : (this.serverWriter?.latestModel(edit.path, edit.variantId) ?? edit.model);
  }

  record(edit: WorkflowEdit, model: AdjustmentModel, action: string, label: string): void {
    this.release(edit);
    const kind = ['preset', 'paste', 'reset', 'undo', 'redo'].includes(action)
      ? action
      : 'adjustment';
    if (edit.backend === 'self-hosted') {
      if (!this.server) throw Error('Self Hosted sidecar persistence is not configured');
      void this.server
        .commitSemantic(
          edit.id,
          edit.path,
          {
            before: edit.model,
            after: model,
            culling: edit.culling,
            cullingPatch: this.isCurrent(edit)
              ? this.library.cullingPatchFor(edit.id)
              : edit.cullingPatch,
            action: kind,
            label,
          },
          edit.variantId,
        )
        .catch(() => undefined);
      return;
    }
    // Publication errors are surfaced by SidecarSaveState; flush retries the captured action.
    void this.writer
      .commitSemantic(
        edit.id,
        edit.folder,
        edit.filename,
        model,
        edit.culling,
        kind,
        label,
        edit.binding,
      )
      .catch(() => undefined);
  }

  release(edit: WorkflowEdit | null): void {
    if (edit?.backend === 'self-hosted') this.serverWriter?.endModel(edit.path, edit.variantId);
  }
}
