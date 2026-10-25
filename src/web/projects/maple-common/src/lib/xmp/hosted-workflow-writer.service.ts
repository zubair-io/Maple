import { Injectable, inject } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import {
  PRIMARY_VARIANT_ID,
  WORKFLOW_HISTORY_LIMIT,
  type SidecarWorkflow,
} from '../generated/workflow.generated';
import type { PassthroughBucket, XmpCulling, XmpMetadata } from './xmp.types';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { HostedSidecarFreshnessService } from './hosted-sidecar-freshness.service';

interface CapturedAction {
  readonly id: string;
  readonly createdAtMs: number;
  readonly action: string;
  readonly label: string;
  readonly model: AdjustmentModel;
  readonly culling: XmpCulling;
}

/** Publication bound to one sidecar, shared by preview saves and semantic actions (#4063). */
@Injectable({ providedIn: 'root' })
export class HostedWorkflowWriterService {
  private readonly access = inject(FolderAccessService);
  private readonly core = inject(WorkflowXmpService);
  private readonly parser = inject(XmpParserService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly freshness = inject(HostedSidecarFreshnessService);
  private readonly actions = new WeakMap<MapleFolderHandle, Map<string, CapturedAction[]>>();

  capture(
    folder: MapleFolderHandle,
    name: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    action: string,
    label: string,
  ): void {
    if (!folder.native || !folder.write || !navigator.locks)
      throw Error('Reopen this folder with filesystem write access to save editor history.');
    const files = this.actions.get(folder) ?? new Map<string, CapturedAction[]>();
    const pending = files.get(name) ?? [];
    if (pending.length >= WORKFLOW_HISTORY_LIMIT)
      throw Error('Save the pending editor history before committing another action.');
    files.set(name, [
      ...pending,
      {
        id: crypto.randomUUID(),
        createdAtMs: Date.now(),
        action,
        label,
        model: structuredClone(model),
        culling: structuredClone(culling),
      },
    ]);
    this.actions.set(folder, files);
  }

  async write(
    folder: MapleFolderHandle,
    name: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    fallback?: PassthroughBucket,
    metadata?: XmpMetadata,
    variantId = PRIMARY_VARIANT_ID,
    expectedDocument?: string | null,
  ): Promise<string> {
    // Validate the frozen binding before acquiring a lock or touching its file.
    await this.core.variantFilename(name, variantId);
    return navigator.locks.request('maple-workflow-variant:' + variantId, async () => {
      const current = await this.freshness.readCurrent(folder, name);
      this.freshness.assertUnchanged(folder, name, current, expectedDocument);
      const workflow = await this.selectedRecord(current, variantId);
      const passthrough =
        current === null ? fallback : this.parser.parseAdjustmentModel(current).passthrough;
      const pending = this.actions.get(folder)?.get(name) ?? [];
      const retained = await pending.reduce(
        async (previous, captured) =>
          this.applyCapture(await previous, captured, passthrough, metadata),
        Promise.resolve(workflow),
      );
      const checkpoint = await this.core.checkpoint(
        this.serializer.serialize(model, passthrough, culling, passthrough ? undefined : metadata),
      );
      const output = retained === null ? checkpoint : await this.core.embed(retained, checkpoint);
      this.freshness.assertUnchanged(
        folder,
        name,
        await this.freshness.readCurrent(folder, name),
        current,
      );
      await this.access.writeFile(folder, name, new TextEncoder().encode(output));
      this.freshness.remember(folder, name, output);
      // Only a successful atomic close acknowledges these immutable captures.
      const published = new Set(pending.map((captured) => captured.id));
      const remaining = (this.actions.get(folder)?.get(name) ?? []).filter(
        (captured) => !published.has(captured.id),
      );
      this.actions.get(folder)?.set(name, remaining);
      return output;
    });
  }
  private async selectedRecord(
    current: string | null,
    variantId: string,
  ): Promise<SidecarWorkflow | null> {
    if (current === null && variantId !== PRIMARY_VARIANT_ID)
      throw Error('Variant sidecar is missing. Restore it before editing.');
    const workflow = current === null ? null : await this.core.read(current);
    if ((workflow?.variantId ?? PRIMARY_VARIANT_ID) !== variantId)
      throw Error('Variant identity does not match the selected sidecar.');
    return workflow;
  }

  private async applyCapture(
    record: SidecarWorkflow | null,
    captured: CapturedAction,
    passthrough?: PassthroughBucket,
    metadata?: XmpMetadata,
  ): Promise<SidecarWorkflow | null> {
    const checkpoint = await this.core.checkpoint(
      this.serializer.serialize(
        captured.model,
        passthrough,
        captured.culling,
        passthrough ? undefined : metadata,
      ),
    );
    const candidate = record === null ? checkpoint : await this.core.embed(record, checkpoint);
    const committed = await this.core.commit(
      {
        id: captured.id,
        createdAtMs: captured.createdAtMs,
        action: captured.action,
        label: captured.label,
        adjustmentXmp: checkpoint,
      },
      candidate,
    );
    return this.core.read(committed);
  }
}
