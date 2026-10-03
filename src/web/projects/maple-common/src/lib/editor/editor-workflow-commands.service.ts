import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { EditorWorkflowHistoryService, type WorkflowEdit } from './editor-workflow-history.service';
import { LibraryStore } from '../state/library-store.service';
import { LibraryFetch } from '../state/library-fetch.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { SidecarStore } from '../xmp/sidecar.store';
import { WorkflowVariantStoreService } from '../xmp/workflow-variant-store.service';
import { WorkflowXmpService } from '../xmp/workflow-xmp.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import {
  PRIMARY_VARIANT_ID,
  type SidecarWorkflow,
  type WorkflowSnapshot,
  type WorkflowHistoryEntry,
} from '../generated/workflow.generated';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import { stableStringify } from './edit-transaction';

export interface WorkflowDocument {
  readonly xml: string | null;
  readonly record: SidecarWorkflow | null;
}
export interface SnapshotCommand {
  readonly source: WorkflowEdit;
  readonly expectedXmp: string | null;
  readonly snapshot: WorkflowSnapshot;
}
export interface RestoreCommand {
  readonly source: WorkflowEdit;
  readonly expectedXmp: string;
  readonly before: string;
  readonly entry: WorkflowHistoryEntry;
}

/** Product commands retain their captured sidecar identity through publication (#4063). */
@Injectable({ providedIn: 'root' })
export class EditorWorkflowCommandsService {
  readonly history: EditorWorkflowHistoryService = inject(EditorWorkflowHistoryService);
  private readonly library: LibraryStore = inject(LibraryStore);
  private readonly writer: XmpStoreService = inject(XmpStoreService);
  private readonly variants: WorkflowVariantStoreService = inject(WorkflowVariantStoreService);
  private readonly core: WorkflowXmpService = inject(WorkflowXmpService);
  private readonly parser: XmpParserService = inject(XmpParserService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly persistence = inject(SERVER_WORKSPACE_PERSISTENCE, { optional: true });
  private readonly server: SidecarStore | null =
    this.library.backend === 'self-hosted' ? inject(SidecarStore) : null;
  private readonly fetcher: LibraryFetch | null =
    this.library.backend === 'self-hosted' ? inject(LibraryFetch) : null;

  capture(id: string, model: AdjustmentModel): WorkflowEdit | null {
    const source = this.history.capture(id, model);
    this.history.release(source);
    return source;
  }

  async load(source: WorkflowEdit): Promise<WorkflowDocument> {
    await this.settle(source);
    return this.read(source);
  }

  async prepareSnapshot(source: WorkflowEdit, name: string): Promise<SnapshotCommand> {
    if (!name.trim()) throw Error('Enter a visible name for the snapshot.');
    await this.settle(source);
    const current = await this.read(source);
    // The first snapshot and its initial sidecar publish together under CAS.
    const xml = current.xml ?? this.serializer.serialize(source.model, undefined, source.culling);
    return {
      source,
      expectedXmp: current.xml,
      snapshot: {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAtMs: Date.now(),
        adjustmentXmp: await this.core.checkpoint(xml),
      },
    };
  }

  async saveSnapshot(command: SnapshotCommand): Promise<string> {
    const { source, expectedXmp, snapshot } = command;
    return this.publish(source, async () => {
      const current = await this.read(source);
      const accepted = current.record?.snapshots.find((entry) => entry.id === snapshot.id);
      if (accepted && stableStringify(accepted) === stableStringify(snapshot)) return current.xml!;
      if (source.backend === 'hosted')
        return this.variants.saveSnapshot(
          source.folder,
          this.primaryName(source),
          source.variantId,
          expectedXmp,
          snapshot,
          expectedXmp === null ? snapshot.adjustmentXmp : undefined,
        );
      if (!this.persistence) throw Error('Self Hosted persistence is unavailable.');
      return firstValueFrom(
        this.persistence.snapshotSidecar(
          source.path,
          expectedXmp,
          snapshot,
          expectedXmp === null ? snapshot.adjustmentXmp : undefined,
          source.variantId,
        ),
      );
    });
  }

  async prepareRestore(
    source: WorkflowEdit,
    document: WorkflowDocument,
    id: string,
  ): Promise<RestoreCommand> {
    if (document.xml === null) throw Error('No saved history exists for this photo.');
    const snapshot = document.record?.snapshots.find((entry) => entry.id === id);
    const historical = document.record?.history.find((entry) => entry.id === id);
    const target = snapshot ?? historical;
    if (!target) throw Error('The selected version is missing. Reload history.');
    return {
      source,
      expectedXmp: document.xml,
      before: await this.core.checkpoint(document.xml),
      entry: this.entry(
        target.adjustmentXmp,
        snapshot ? 'snapshot-restore' : 'history-restore',
        `Restore ${snapshot?.name ?? historical!.label}`,
      ),
    };
  }

  async prepareReplay(
    source: WorkflowEdit,
    checkpoint: string,
    action: 'undo' | 'redo',
    label: string,
  ): Promise<RestoreCommand> {
    const document = await this.load(source);
    if (document.xml === null) throw Error('The primary sidecar is missing. Reopen the photo.');
    return {
      source,
      expectedXmp: document.xml,
      before: await this.core.checkpoint(document.xml),
      entry: this.entry(checkpoint, action, label),
    };
  }

  restore(command: RestoreCommand): Promise<string> {
    return this.publish(command.source, () => this.restoreCurrent(command));
  }

  private async restoreCurrent(command: RestoreCommand): Promise<string> {
    const { source, expectedXmp, entry } = command;
    const current = await this.read(source);
    const accepted = current.record?.history.find((saved) => saved.id === entry.id);
    if (accepted && stableStringify(accepted) === stableStringify(entry)) return current.xml!;
    if (current.xml !== expectedXmp)
      throw Error('Variant changed. Reopen it before saving this action.');
    // Only the shared converter's necessary self-closing Description expansion
    // is ignored; foreign bytes and authored whitespace remain exact (#4062).
    const target = current.record
      ? await this.core.checkpoint(await this.core.embed(current.record, entry.adjustmentXmp))
      : entry.adjustmentXmp;
    if (target === command.before) return current.xml!;
    return this.publishEntry(command);
  }

  private publishEntry(command: RestoreCommand): Promise<string> {
    const { source, expectedXmp, entry } = command;
    const restore = entry.action === 'snapshot-restore' || entry.action === 'history-restore';
    if (source.backend === 'hosted') {
      const name = this.primaryName(source);
      return restore
        ? this.variants.restore(source.folder, name, source.variantId, expectedXmp, entry)
        : this.variants.commit(
            source.folder,
            name,
            source.variantId,
            expectedXmp,
            entry.adjustmentXmp,
            entry,
          );
    }
    if (!this.persistence) throw Error('Self Hosted persistence is unavailable.');
    return firstValueFrom(
      restore
        ? this.persistence.restoreSidecar(source.path, expectedXmp, entry, source.variantId)
        : this.persistence.commitSidecar(
            source.path,
            expectedXmp,
            entry.adjustmentXmp,
            entry,
            source.variantId,
          ),
    );
  }

  model(source: WorkflowEdit, xml: string): AdjustmentModel {
    const parsed = { ...defaultAdjustmentModel(), ...this.parser.parseAdjustmentModel(xml).model };
    return this.library.hydrateAdjustment(source.id, parsed);
  }

  apply(source: WorkflowEdit, xml: string): void {
    if (!this.history.isCurrent(source)) return;
    const model = this.model(source, xml);
    this.library.setAdjustment(source.id, model);
    this.library.setCulling(source.id, this.parser.parseCulling(xml));
    this.fetcher?.rememberWorkflowRestore(source.id, xml, model);
    this.library.assets.update((assets) =>
      assets.map((asset) => (asset.id === source.id ? { ...asset, edited: true } : asset)),
    );
  }

  private entry(adjustmentXmp: string, action: string, label: string): WorkflowHistoryEntry {
    return { id: crypto.randomUUID(), createdAtMs: Date.now(), action, label, adjustmentXmp };
  }
  private async settle(source: WorkflowEdit): Promise<void> {
    if (source.backend === 'hosted') await this.writer.settleAsset(source.id);
    else await this.fetcher?.settleSidecar(source.id);
  }
  private async publish(source: WorkflowEdit, publish: () => Promise<string>): Promise<string> {
    await this.settle(source);
    if (source.backend === 'hosted')
      return this.writer.publishWorkflow(source.id, publish, () => this.history.isCurrent(source));
    if (!this.server) throw Error('Self Hosted persistence is unavailable.');
    return this.server.publishWorkflow(source.id, source.path, publish, source.variantId);
  }
  private async read(source: WorkflowEdit): Promise<WorkflowDocument> {
    const xml =
      source.backend === 'hosted'
        ? await this.variants.read(source.folder, this.primaryName(source), source.variantId)
        : await this.readServer(source.path, source.variantId);
    const record = xml === null ? null : await this.core.read(xml);
    if ((record?.variantId ?? PRIMARY_VARIANT_ID) !== source.variantId)
      throw Error(
        'Variant identity does not match the selected sidecar. Repair it before editing.',
      );
    return { xml, record };
  }
  private readServer(path: string, variantId: string): Promise<string | null> {
    if (!this.persistence) throw Error('Self Hosted persistence is unavailable.');
    return firstValueFrom(this.persistence.readSidecar(path, variantId)).catch((error: unknown) => {
      if (
        variantId === PRIMARY_VARIANT_ID &&
        error instanceof HttpErrorResponse &&
        error.status === 404
      )
        return null;
      throw error;
    });
  }
  private primaryName(source: WorkflowEdit): string {
    return source.filename.replace(/\.[^.]+$/, '') + '.xmp';
  }
}
