import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { EditorStateService } from './editor-state.service';
import { EditorWorkflowCommandsService } from './editor-workflow-commands.service';
import type { WorkflowEdit } from './editor-workflow-history.service';
import { LibraryStore } from '../state/library-store.service';
import { LibraryFetch } from '../state/library-fetch.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { SidecarStore } from '../xmp/sidecar.store';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { WorkflowXmpService } from '../xmp/workflow-xmp.service';
import {
  WorkflowVariantStoreService,
  type WorkflowVariantSidecar,
} from '../xmp/workflow-variant-store.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import {
  WORKFLOW_VARIANT_SERVER,
  type WorkflowVariantServer,
} from '../workspace/workflow-variant-server';
import { PRIMARY_VARIANT_ID, type SidecarWorkflow } from '../generated/workflow.generated';
import { stableStringify } from './edit-transaction';
import { defaultAdjustmentModel } from '../models/adjustment-model';

export interface CreateVariantCommand {
  readonly source: WorkflowEdit;
  readonly workflow: SidecarWorkflow;
  readonly expectedCheckpoint: string;
}

/** Actual sibling files own branch contents; UI selection never redirects an admitted save (#4063). */
@Injectable({ providedIn: 'root' })
export class EditorWorkflowVariantsService {
  private readonly library = inject(LibraryStore);
  private readonly editor = inject(EditorStateService);
  private readonly commands = inject(EditorWorkflowCommandsService);
  private readonly writer = inject(XmpStoreService);
  private readonly variants = inject(WorkflowVariantStoreService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly parser = inject(XmpParserService);
  private readonly core = inject(WorkflowXmpService);
  private readonly server: WorkflowVariantServer | null = inject(WORKFLOW_VARIANT_SERVER, {
    optional: true,
  });
  private readonly persistence = inject(SERVER_WORKSPACE_PERSISTENCE, { optional: true });
  private readonly fetcher: LibraryFetch | null =
    this.library.backend === 'self-hosted' ? inject(LibraryFetch) : null;
  private readonly sidecars = this.library.backend === 'self-hosted' ? inject(SidecarStore) : null;

  async list(source: WorkflowEdit): Promise<WorkflowVariantSidecar[]> {
    await this.commands.load(source);
    if (source.backend === 'hosted')
      return this.variants.list(source.folder, this.primaryName(source));
    if (!this.server) throw Error('Self Hosted variant storage is unavailable.');
    return firstValueFrom(this.server.list(source.path));
  }

  async prepareCreate(source: WorkflowEdit, name: string): Promise<CreateVariantCommand> {
    const trimmed = name.trim();
    if (!trimmed) throw Error('Enter a visible name for the variant.');
    const current = await this.commands.load(source);
    const xml = current.xml ?? (await this.createInitialSidecar(source));
    const workflow: SidecarWorkflow = {
      schemaVersion: 1,
      variantId: crypto.randomUUID(),
      variantName: trimmed,
      snapshots: [],
      history: [],
    };
    return {
      source,
      workflow,
      expectedCheckpoint: await this.core.checkpoint(await this.core.embed(workflow, xml)),
    };
  }

  async create(command: CreateVariantCommand): Promise<WorkflowVariantSidecar> {
    const { source, workflow } = command;
    await this.commands.load(source);
    try {
      if (source.backend === 'hosted')
        return await this.variants.create(
          source.folder,
          this.primaryName(source),
          workflow,
          source.variantId,
        );
      if (!this.server) throw Error('Self Hosted variant storage is unavailable.');
      return await firstValueFrom(this.server.create(source.path, workflow, source.variantId));
    } catch (error) {
      // An accepted create can lose its acknowledgement. Reuse the frozen UUID
      // only when both its metadata and complete checkpoint match this command.
      const xml = await this.read(source, workflow.variantId).catch(() => null);
      if (xml === null) throw error;
      const record = await this.core.read(xml);
      if (
        stableStringify(record) !== stableStringify(workflow) ||
        (await this.core.checkpoint(xml)) !== command.expectedCheckpoint
      )
        throw error;
      return {
        variantId: workflow.variantId,
        filename: await this.core.variantFilename(this.primaryName(source), workflow.variantId),
        workflow: record,
        exists: true,
      };
    }
  }

  async select(source: WorkflowEdit, variantId: string): Promise<void> {
    if (this.editor.workflowBusy()) throw Error('Wait for the current workflow action to finish.');
    this.editor.endEdit();
    const generation = this.editor.bindingGeneration;
    const current = () =>
      this.editor.bindingGeneration === generation && this.editor.imageId() === source.id;
    this.editor.workflowBusy.set(true);
    try {
      await this.commands.load(source);
      const xml = await this.read(source, variantId);
      if (!current() || !this.commands.history.isCurrent(source))
        throw Error('The editor source changed while loading this variant.');
      const selectedXml =
        source.backend === 'hosted'
          ? (
              await this.writer.bindVariant(
                source.id,
                source.folder,
                source.filename,
                variantId,
                current,
              )
            ).xml
          : xml;
      if (!current()) return;
      this.applySelection(source, variantId, selectedXml);
    } finally {
      this.editor.workflowBusy.set(false);
    }
  }

  private applySelection(source: WorkflowEdit, variantId: string, xml: string | null): void {
    const model = this.commands.model(
      source,
      xml ?? this.serializer.serialize(defaultAdjustmentModel()),
    );
    if (source.backend === 'self-hosted') {
      if (!this.fetcher) throw Error('Self Hosted variant storage is unavailable.');
      this.fetcher.bindWorkflowVariant(source.id, source.path, variantId, xml, model);
    }
    this.library.markSessionEdited(source.id);
    this.library.setAdjustment(source.id, model);
    this.library.setCulling(
      source.id,
      xml === null
        ? { rating: 0, flag: 'unflagged', colorLabel: null, keywords: [] }
        : this.parser.parseCulling(xml),
    );
    this.editor.bind(source.id);
    void this.editor.announcer.announce(
      variantId === PRIMARY_VARIANT_ID ? 'Primary variant selected' : 'Variant selected',
    );
  }

  private async createInitialSidecar(source: WorkflowEdit): Promise<string> {
    if (source.variantId !== PRIMARY_VARIANT_ID)
      throw Error('Variant sidecar is missing. Restore it before editing.');
    if (source.backend === 'hosted') {
      this.writer.scheduleWrite(
        source.id,
        source.folder,
        source.filename,
        source.model,
        source.culling,
      );
      await this.writer.flushAsset(source.id);
    } else {
      if (!this.sidecars) throw Error('Self Hosted variant storage is unavailable.');
      await this.sidecars.write(
        source.path,
        this.serializer.serialize(source.model, undefined, source.culling),
      );
    }
    const committed = await this.read(source, source.variantId);
    if (committed === null) throw Error('The committed source sidecar is missing.');
    return committed;
  }

  private async read(source: WorkflowEdit, variantId: string): Promise<string | null> {
    if (source.backend === 'hosted')
      return this.variants.read(source.folder, this.primaryName(source), variantId);
    if (!this.persistence) throw Error('Self Hosted variant storage is unavailable.');
    const xml = await firstValueFrom(this.persistence.readSidecar(source.path, variantId)).catch(
      (error: unknown) => {
        if (
          variantId === PRIMARY_VARIANT_ID &&
          error instanceof HttpErrorResponse &&
          error.status === 404
        )
          return null;
        throw error;
      },
    );
    const record = xml === null ? null : await this.core.read(xml);
    if ((record?.variantId ?? PRIMARY_VARIANT_ID) !== variantId)
      throw Error('Variant identity does not match the selected sidecar.');
    return xml;
  }

  private primaryName(source: WorkflowEdit): string {
    return source.filename.replace(/\.[^.]+$/, '') + '.xmp';
  }
}
