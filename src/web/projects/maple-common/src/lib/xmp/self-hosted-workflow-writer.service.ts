import { Injectable, inject } from '@angular/core';
import { defer, firstValueFrom, type Observable } from 'rxjs';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling } from './xmp.types';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import { WORKFLOW_HISTORY_LIMIT, PRIMARY_VARIANT_ID } from '../generated/workflow.generated';
import { workflowSidecarKey, type WorkflowSidecarBinding } from './workflow-sidecar-binding';

export interface SelfHostedSemanticEdit {
  readonly before: AdjustmentModel;
  readonly after: AdjustmentModel;
  readonly culling: XmpCulling;
  readonly cullingPatch: Readonly<Partial<XmpCulling>>;
  readonly action: string;
  readonly label: string;
}

interface CapturedAction {
  readonly id: string;
  readonly createdAtMs: number;
  readonly action: string;
  readonly label: string;
  readonly model: AdjustmentModel;
  readonly patch: Partial<AdjustmentModel>;
  readonly culling: XmpCulling;
  readonly cullingPatch: Readonly<Partial<XmpCulling>>;
}

/** HTTP publication uses immutable gesture intent and the actual current source XML (#4053). */
@Injectable({ providedIn: 'root' })
export class SelfHostedWorkflowWriterService {
  private readonly persistence = inject(SERVER_WORKSPACE_PERSISTENCE, { optional: true });
  private readonly parser = inject(XmpParserService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly core = inject(WorkflowXmpService);
  private readonly actions = new Map<string, readonly CapturedAction[]>();
  private readonly sources = new Map<string, WorkflowSidecarBinding>();
  // Only the armed editor gesture needs a live preview model. Semantic actions
  // already own immutable retry captures; browsing must not retain every path (#4058).
  private activePath: string | null = null;
  private activeModel: AdjustmentModel | undefined;

  beginModel(path: string, model: AdjustmentModel, variantId = PRIMARY_VARIANT_ID): void {
    this.activePath = workflowSidecarKey(path, variantId);
    this.activeModel = model;
  }

  endModel(path: string, variantId = PRIMARY_VARIANT_ID): void {
    if (this.activePath !== workflowSidecarKey(path, variantId)) return;
    this.activePath = null;
    this.activeModel = undefined;
  }

  noteModel(path: string, model: AdjustmentModel, variantId = PRIMARY_VARIANT_ID): void {
    if (this.activePath === workflowSidecarKey(path, variantId)) this.activeModel = model;
  }
  latestModel(path: string, variantId = PRIMARY_VARIANT_ID): AdjustmentModel | undefined {
    return this.activePath === workflowSidecarKey(path, variantId) ? this.activeModel : undefined;
  }
  hasPending(path: string, variantId = PRIMARY_VARIANT_ID): boolean {
    return (this.actions.get(workflowSidecarKey(path, variantId))?.length ?? 0) > 0;
  }
  pendingSources(): readonly WorkflowSidecarBinding[] {
    return [...this.sources.values()];
  }

  capture(path: string, edit: SelfHostedSemanticEdit, variantId = PRIMARY_VARIANT_ID): void {
    const { before, after, culling, cullingPatch, action, label } = edit;
    const patch = Object.fromEntries(
      Object.entries(after).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(Reflect.get(before, key)),
      ),
    ) as Partial<AdjustmentModel>;
    const captured: CapturedAction = structuredClone({
      id: crypto.randomUUID(),
      createdAtMs: Date.now(),
      action,
      label,
      model: after,
      patch,
      culling,
      cullingPatch,
    });
    const key = workflowSidecarKey(path, variantId);
    this.actions.set(
      key,
      [...(this.actions.get(key) ?? []), captured].slice(-WORKFLOW_HISTORY_LIMIT),
    );
    this.sources.set(key, { path, variantId });
    this.noteModel(path, after, variantId);
  }

  read(path: string, variantId = PRIMARY_VARIANT_ID): Observable<string | null> {
    return defer(() => this.readCurrent(path, variantId));
  }

  flush(path: string, variantId = PRIMARY_VARIANT_ID): Observable<string | null> {
    return defer(() => this.publishCaptured(path, variantId));
  }
  private async readCurrent(path: string, variantId: string): Promise<string | null> {
    if (!this.persistence) throw Error('Self Hosted sidecar persistence is not configured');
    try {
      return await firstValueFrom(this.persistence.readSidecar(path, variantId));
    } catch (error) {
      if (
        variantId === PRIMARY_VARIANT_ID &&
        error &&
        typeof error === 'object' &&
        Reflect.get(error, 'status') === 404
      )
        return null;
      throw error;
    }
  }
  private async publishCaptured(path: string, variantId: string): Promise<string | null> {
    const key = workflowSidecarKey(path, variantId);
    const pending = [...(this.actions.get(key) ?? [])];
    const source = await this.readCurrent(path, variantId);
    await this.selectedRecord(source, variantId);
    return pending.reduce(async (previous, captured) => {
      const current = await previous;
      const workflow = await this.selectedRecord(current, variantId);
      // A lost HTTP response may follow a successful atomic save. Its stable
      // captured UUID acknowledges the already-persisted action on retry.
      const published = workflow?.history.some((entry) => entry.id === captured.id)
        ? current
        : await this.commit(path, current, captured, variantId);
      const remaining = (this.actions.get(key) ?? []).filter((entry) => entry.id !== captured.id);
      if (remaining.length === 0) {
        this.actions.delete(key);
        this.sources.delete(key);
      } else this.actions.set(key, remaining);
      return published;
    }, Promise.resolve(source));
  }
  private async selectedRecord(xml: string | null, variantId: string) {
    if (xml === null && variantId !== PRIMARY_VARIANT_ID)
      throw Error('Variant sidecar is missing. Restore it before editing.');
    const record = xml === null ? null : await this.core.read(xml);
    if ((record?.variantId ?? PRIMARY_VARIANT_ID) !== variantId)
      throw Error('Variant identity does not match the selected sidecar.');
    return record;
  }
  private async commit(
    path: string,
    current: string | null,
    captured: CapturedAction,
    variantId: string,
  ) {
    if (!this.persistence) throw Error('Self Hosted sidecar persistence is not configured');
    const parsed = current === null ? null : this.parser.parseAdjustmentModel(current);
    const checkpoint = await this.core.checkpoint(
      this.serializer.serialize(
        { ...captured.model, ...parsed?.model, ...captured.patch },
        parsed?.passthrough,
        {
          ...captured.culling,
          ...(current === null ? {} : this.parser.parseCulling(current)),
          ...captured.cullingPatch,
        },
        parsed ? undefined : {},
      ),
    );
    return firstValueFrom(
      this.persistence.commitSidecar(
        path,
        current,
        checkpoint,
        {
          id: captured.id,
          createdAtMs: captured.createdAtMs,
          action: captured.action,
          label: captured.label,
          adjustmentXmp: checkpoint,
        },
        variantId,
      ),
    );
  }
}
