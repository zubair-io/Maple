import { Injectable, inject } from '@angular/core';
import { defer, firstValueFrom, type Observable } from 'rxjs';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling } from './xmp.types';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import { WORKFLOW_HISTORY_LIMIT, PRIMARY_VARIANT_ID } from '../generated/workflow.generated';

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
  // Only the armed editor gesture needs a live preview model. Semantic actions
  // already own immutable retry captures; browsing must not retain every path (#4058).
  private activePath: string | null = null;
  private activeModel: AdjustmentModel | undefined;

  beginModel(path: string, model: AdjustmentModel): void {
    this.activePath = path;
    this.activeModel = model;
  }

  endModel(path: string): void {
    if (this.activePath !== path) return;
    this.activePath = null;
    this.activeModel = undefined;
  }

  noteModel(path: string, model: AdjustmentModel): void {
    if (this.activePath === path) this.activeModel = model;
  }
  latestModel(path: string): AdjustmentModel | undefined {
    return this.activePath === path ? this.activeModel : undefined;
  }
  hasPending(path: string): boolean {
    return (this.actions.get(path)?.length ?? 0) > 0;
  }
  pendingPaths(): readonly string[] {
    return [...this.actions.keys()];
  }

  capture(path: string, edit: SelfHostedSemanticEdit): void {
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
    this.actions.set(
      path,
      [...(this.actions.get(path) ?? []), captured].slice(-WORKFLOW_HISTORY_LIMIT),
    );
    this.noteModel(path, after);
  }

  read(path: string): Observable<string | null> {
    return defer(() => this.readCurrent(path));
  }

  flush(path: string): Observable<string | null> {
    return defer(() => this.publishCaptured(path));
  }
  private async readCurrent(path: string): Promise<string | null> {
    if (!this.persistence) throw Error('Self Hosted sidecar persistence is not configured');
    try {
      return await firstValueFrom(this.persistence.readSidecar(path));
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'status') === 404) return null;
      throw error;
    }
  }
  private async publishCaptured(path: string): Promise<string | null> {
    const pending = [...(this.actions.get(path) ?? [])];
    const source = await this.readCurrent(path);
    await this.primaryRecord(source);
    return pending.reduce(async (previous, captured) => {
      const current = await previous;
      const workflow = await this.primaryRecord(current);
      // A lost HTTP response may follow a successful atomic save. Its stable
      // captured UUID acknowledges the already-persisted action on retry.
      const published = workflow?.history.some((entry) => entry.id === captured.id)
        ? current
        : await this.commit(path, current, captured);
      const remaining = (this.actions.get(path) ?? []).filter((entry) => entry.id !== captured.id);
      if (remaining.length === 0) this.actions.delete(path);
      else this.actions.set(path, remaining);
      return published;
    }, Promise.resolve(source));
  }
  private async primaryRecord(xml: string | null) {
    const record = xml === null ? null : await this.core.read(xml);
    if ((record?.variantId ?? PRIMARY_VARIANT_ID) !== PRIMARY_VARIANT_ID)
      throw Error('Variant identity does not match the primary sidecar.');
    return record;
  }
  private async commit(path: string, current: string | null, captured: CapturedAction) {
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
      this.persistence.commitSidecar(path, current, checkpoint, {
        id: captured.id,
        createdAtMs: captured.createdAtMs,
        action: captured.action,
        label: captured.label,
        adjustmentXmp: checkpoint,
      }),
    );
  }
}
