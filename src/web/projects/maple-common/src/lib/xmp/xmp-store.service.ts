// Debounced and confirmed XMP publication over one per-asset write queue.

import { Injectable, inject, DestroyRef, signal } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling, PassthroughBucket, XmpMetadata } from './xmp.types';
import type { AssetId } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { SidecarSaveStateService } from './sidecar-save-state.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpParserService } from './xmp-parser.service';
import { HostedWorkflowWriterService } from './hosted-workflow-writer.service';
import {
  PRIMARY_VARIANT_ID,
  WORKFLOW_MARKUP_PATTERN,
  type SidecarWorkflow,
} from '../generated/workflow.generated';

import {
  HostedSidecarBindingsService,
  type HostedSidecarBinding,
} from './hosted-sidecar-bindings.service';
export type { HostedSidecarBinding } from './hosted-sidecar-bindings.service';
import { SidecarFileIoService } from './sidecar-file-io.service';
import { HostedRemovalWriterService } from './hosted-removal-writer.service';
import { withRemovalWriteLock } from '../removal/removal-write-lock';
import { XmpStoreWrites } from './xmp-store.writes';

@Injectable({ providedIn: 'root' })
export class XmpStoreService {
  private readonly files = inject(SidecarFileIoService);
  private readonly removalWriter = inject(HostedRemovalWriterService);
  private folderAccess = inject(FolderAccessService);
  private serializer = inject(XmpSerializerService);
  private saveState = inject(SidecarSaveStateService);
  private readonly workflowCore = inject(WorkflowXmpService);
  private readonly parser = inject(XmpParserService);
  private readonly hostedWriter = inject(HostedWorkflowWriterService);
  private readonly destroyRef = inject(DestroyRef, { optional: true });
  private readonly latestModels = new WeakMap<MapleFolderHandle, Map<AssetId, AdjustmentModel>>();

  constructor() {
    this.destroyRef?.onDestroy(() => this.cancelPending());
  }

  /** Cancel all pending debounce timers without starting new writes. */
  cancelPending(): void {
    for (const pending of this._pendingWrites.values()) clearTimeout(pending.timeout);
    this._pendingWrites.clear();
  }
  private readonly bindings = inject(HostedSidecarBindingsService);
  private readonly retryWrites = new Map<
    AssetId,
    {
      folder: MapleFolderHandle;
      rawFilename: string;
      binding: HostedSidecarBinding;
      run: () => Promise<void>;
    }[]
  >();

  // Leave 100ms for browser scheduling and File System Access dispatch while
  // meeting the 250ms edit-to-sidecar contract in installed Chrome.
  private readonly DEBOUNCE_MS = 150;

  private _pendingWrites = new Map<
    AssetId,
    {
      timeout: ReturnType<typeof setTimeout>;
      folder: MapleFolderHandle;
      rawFilename: string;
      model: AdjustmentModel;
      culling: XmpCulling;
      revision: number;
      binding: HostedSidecarBinding;
    }
  >();
  // Browser workflow gate calls this through a nested handler; product controls follow #2437.
  // fallow-ignore-next-line unused-class-member
  async writeWorkflow(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    workflow: SidecarWorkflow,
  ): Promise<void> {
    if (!folder.write) throw new Error('Reopen this folder with write access.');
    const binding = this.bindingFor(assetId, folder, rawFilename);
    if (this._pendingWrites.has(assetId)) await this.flushAsset(assetId);
    const prior = this._inFlightWrites.get(assetId) ?? Promise.resolve();
    const write = prior
      .then(async () => {
        const publish = async () => {
          const passthrough = await this.files.writeWorkflow(
            folder,
            binding.filename,
            workflow,
            binding.variantId,
          );
          if (this.bindingFor(assetId, folder, rawFilename).variantId === binding.variantId)
            this.rememberPassthrough(assetId, passthrough);
        };
        if (folder.native && navigator.locks)
          await withRemovalWriteLock(folder, rawFilename, () =>
            navigator.locks.request('maple-workflow-variant:' + binding.variantId, publish),
          );
        else await publish();
      })
      .finally(() => {
        if (this._inFlightWrites.get(assetId) === write) this._inFlightWrites.delete(assetId);
      });
    this._inFlightWrites.set(assetId, write);
    await write;
  }

  private readonly _inFlightWrites = new Map<AssetId, Promise<void>>();
  private readonly writes = new XmpStoreWrites(
    this.files,
    this.removalWriter,
    this.saveState,
    this.parser,
    this._inFlightWrites,
    (assetId) => this.settleAsset(assetId),
    (assetId) => this._pendingWrites.has(assetId) || this._inFlightWrites.has(assetId),
    (assetId, folder, rawFilename) => this.bindingFor(assetId, folder, rawFilename),
    (assetId) => this.flushAsset(assetId),
    (assetId) => {
      const pending = this._pendingWrites.get(assetId);
      if (pending) clearTimeout(pending.timeout);
      this._pendingWrites.delete(assetId);
    },
    (assetId, passthrough) => this.rememberPassthrough(assetId, passthrough),
  );

  private _passthroughs = new Map<AssetId, PassthroughBucket>();
  private readonly passthroughRevision = signal(0);
  private readonly _metadata = new Map<AssetId, XmpMetadata>();

  rememberMetadata(assetId: AssetId, metadata: XmpMetadata): void {
    this._metadata.set(assetId, metadata);
  }

  rememberPassthrough(assetId: AssetId, passthrough: PassthroughBucket): void {
    this._passthroughs.set(assetId, passthrough);
    this.passthroughRevision.update((revision) => revision + 1);
  }

  replacePassthroughs(
    assetIds: Iterable<AssetId>,
    replacements: ReadonlyMap<AssetId, PassthroughBucket>,
    metadataReplacements: ReadonlyMap<AssetId, XmpMetadata> = new Map(),
  ): void {
    for (const assetId of assetIds) {
      this._passthroughs.delete(assetId);
      this._metadata.delete(assetId);
    }
    for (const [assetId, passthrough] of replacements) {
      this._passthroughs.set(assetId, passthrough);
    }
    for (const [assetId, metadata] of metadataReplacements) {
      this._metadata.set(assetId, metadata);
    }
    this.passthroughRevision.update((revision) => revision + 1);
  }

  passthroughFor(assetId: AssetId): PassthroughBucket | undefined {
    this.passthroughRevision();
    return this._passthroughs.get(assetId);
  }

  metadataFor(assetId: AssetId): XmpMetadata | undefined {
    return this._metadata.get(assetId);
  }

  async bindVariant(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    variantId: string,
    currentSource: () => boolean = () => true,
  ) {
    await this.settleAsset(assetId);
    const xml = await this.bindings.bind(assetId, folder, rawFilename, variantId, currentSource);
    this.latestModels.get(folder)?.delete(this.modelKey(assetId, variantId));
    return this.adoptVariantDocument(assetId, xml);
  }

  private adoptVariantDocument(assetId: AssetId, xml: string | null) {
    const parsed = xml === null ? null : this.parser.parseAdjustmentModel(xml);
    this.replacePassthroughs(
      [assetId],
      parsed ? new Map([[assetId, parsed.passthrough]]) : new Map(),
      parsed ? new Map([[assetId, parsed.metadata]]) : new Map(),
    );
    return {
      xml,
      model: parsed?.model ?? {},
      culling:
        xml === null
          ? { rating: 0, flag: 'unflagged' as const, colorLabel: null, keywords: [] }
          : this.parser.parseCulling(xml),
    };
  }

  bindingFor(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
  ): HostedSidecarBinding {
    return this.bindings.get(assetId, folder, rawFilename);
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  scheduleWrite(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
  ): void {
    if (!folder.write) return;
    const binding = this.bindingFor(assetId, folder, rawFilename);
    const models = this.latestModels.get(folder) ?? new Map<AssetId, AdjustmentModel>();
    models.set(this.modelKey(assetId, binding.variantId), structuredClone(model));
    this.latestModels.set(folder, models);
    const revision = this.saveState.queued(assetId);

    const existing = this._pendingWrites.get(assetId);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      this._pendingWrites.delete(assetId);
      void this._startWrite(
        assetId,
        folder,
        rawFilename,
        model,
        culling,
        revision,
        this._passthroughs.get(assetId),
        binding,
      ).catch(() => undefined);
    }, this.DEBOUNCE_MS);

    this._pendingWrites.set(assetId, {
      timeout,
      folder,
      rawFilename,
      model,
      culling,
      revision,
      binding,
    });
  }

  latestModel(
    assetId: AssetId,
    folder: MapleFolderHandle,
    variantId = PRIMARY_VARIANT_ID,
  ): AdjustmentModel | undefined {
    return this.latestModels.get(folder)?.get(this.modelKey(assetId, variantId));
  }

  private modelKey(assetId: AssetId, variantId: string): string {
    return assetId + '\0' + variantId;
  }

  async commitSemantic(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    action: string,
    label: string,
    capturedBinding?: HostedSidecarBinding,
  ): Promise<void> {
    const revision = this.saveState.queued(assetId);
    try {
      const binding = capturedBinding ?? this.bindingFor(assetId, folder, rawFilename);
      if (binding.folder !== folder || binding.rawFilename !== rawFilename)
        throw Error('Captured variant belongs to another source.');
      this.hostedWriter.capture(folder, binding.filename, model, culling, action, label);
      const pending = this._pendingWrites.get(assetId);
      if (pending?.folder === folder) {
        clearTimeout(pending.timeout);
        this._pendingWrites.delete(assetId);
      }
      await this._startWrite(
        assetId,
        folder,
        rawFilename,
        structuredClone(model),
        structuredClone(culling),
        revision,
        undefined,
        binding,
      );
    } catch (error) {
      this.saveState.failed(assetId, revision, error);
      throw error;
    }
  }

  async flushAsset(id: AssetId): Promise<void> {
    const pending = this._pendingWrites.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      this._pendingWrites.delete(id);
      return this._startWrite(
        id,
        pending.folder,
        pending.rawFilename,
        pending.model,
        pending.culling,
        pending.revision,
        this._passthroughs.get(id),
        pending.binding,
      );
    }
    const inFlight = this._inFlightWrites.get(id);
    if (inFlight) return inFlight;
    const retry = this.retryWrites.get(id);
    if (retry) return Promise.all(retry.map((write) => write.run())).then(() => undefined);
    throw new Error(
      'No writable sidecar was queued for this photo. Reopen its folder with write access.',
    );
  }

  async settleAsset(id: AssetId): Promise<void> {
    if (this._pendingWrites.has(id) || this._inFlightWrites.has(id) || this.retryWrites.has(id))
      await this.flushAsset(id);
  }

  async publishWorkflow(
    assetId: AssetId,
    publish: () => Promise<string>,
    currentSource: () => boolean,
  ): Promise<string> {
    return this.writes.publishWorkflow(assetId, publish, currentSource, (id, metadata) =>
      this.rememberMetadata(id, metadata),
    );
  }

  async captureRemovalRevision(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
  ): Promise<string> {
    return this.writes.captureRevision(assetId, folder, rawFilename);
  }

  async writeRemovalConfirmed(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    expectedRecords: string,
    records: string,
    expectedRevision?: string,
  ): Promise<string> {
    return this.writes.writeConfirmed(
      assetId,
      folder,
      rawFilename,
      model,
      culling,
      expectedRecords,
      records,
      expectedRevision,
    );
  }

  async flushAll(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const [id, pending] of this._pendingWrites.entries()) {
      clearTimeout(pending.timeout);
      writes.push(
        this._startWrite(
          id,
          pending.folder,
          pending.rawFilename,
          pending.model,
          pending.culling,
          pending.revision,
          this._passthroughs.get(id),
          pending.binding,
        ),
      );
    }
    this._pendingWrites.clear();
    await settleWrites(new Set([...this._inFlightWrites.values(), ...writes]));
    await settleWrites(
      [...this.retryWrites.values()].flatMap((scope) => scope.map((write) => write.run())),
    );
  }

  private _startWrite(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    revision: number,
    passthrough?: PassthroughBucket,
    binding = this.bindingFor(assetId, folder, rawFilename),
  ): Promise<void> {
    // File System Access writes are asynchronous. Serialize writes for the
    // same asset so an older, slower write can never overwrite a newer edit.
    const prior = this._inFlightWrites.get(assetId) ?? Promise.resolve();
    const write = prior
      .catch(() => undefined)
      .then(async () => {
        try {
          await this._flushWrite(assetId, model, culling, revision, passthrough, binding);
          const remaining = (this.retryWrites.get(assetId) ?? []).filter(
            (retry) =>
              retry.folder !== folder ||
              retry.rawFilename !== rawFilename ||
              retry.binding.variantId !== binding.variantId,
          );
          if (remaining.length === 0) this.retryWrites.delete(assetId);
          else this.retryWrites.set(assetId, remaining);
        } catch (error) {
          const retained = (this.retryWrites.get(assetId) ?? []).filter(
            (retry) =>
              retry.folder !== folder ||
              retry.rawFilename !== rawFilename ||
              retry.binding.variantId !== binding.variantId,
          );
          this.retryWrites.set(assetId, [
            ...retained,
            {
              folder,
              rawFilename,
              binding,
              run: () =>
                this._startWrite(
                  assetId,
                  folder,
                  rawFilename,
                  model,
                  culling,
                  revision,
                  passthrough,
                  binding,
                ),
            },
          ]);
          throw error;
        }
      })
      .finally(() => {
        if (this._inFlightWrites.get(assetId) === write) {
          this._inFlightWrites.delete(assetId);
        }
      });
    this._inFlightWrites.set(assetId, write);
    return write;
  }

  /** The written document becomes the next save's source, so an edited rating or label is not resurrected from the old bytes (#4403). */
  private _rememberWritten(assetId: AssetId, written: string, current: boolean): void {
    if (current)
      this._passthroughs.set(assetId, this.parser.parseAdjustmentModel(written).passthrough);
  }

  private async _flushWrite(
    assetId: AssetId,
    model: AdjustmentModel,
    culling: XmpCulling,
    revision: number,
    passthrough: PassthroughBucket | undefined,
    binding: HostedSidecarBinding,
  ): Promise<void> {
    const { folder, rawFilename, filename: sidecarName } = binding;
    this.saveState.saving(assetId, revision);
    // Source XML retains language alternatives and multiple creators that the
    // typed cache cannot represent. Use cached metadata only without source XML.
    // A workflow save may have completed while this edit waited in the chain.
    const currentSource = () =>
      this.bindingFor(assetId, folder, rawFilename).variantId === binding.variantId;
    const currentPassthrough = currentSource()
      ? (this._passthroughs.get(assetId) ?? passthrough)
      : passthrough;
    const metadata = currentPassthrough ? undefined : this._metadata.get(assetId);
    const xml = this.serializer.serialize(model, currentPassthrough, culling, metadata);
    const bytes = new TextEncoder().encode(xml);
    try {
      if (folder.native && navigator.locks) {
        const output = await withRemovalWriteLock(folder, rawFilename, () =>
          this.hostedWriter.write(
            folder,
            sidecarName,
            model,
            culling,
            currentPassthrough,
            metadata,
            binding.variantId,
          ),
        );
        this._rememberWritten(assetId, output, currentSource());
        this.saveState.saved(assetId, revision);
        return;
      }
      if (new RegExp(WORKFLOW_MARKUP_PATTERN, 'u').test(xml)) await this.workflowCore.read(xml);
      // FolderAccessService.writeFile uses FS Access writable-stream on Chromium,
      // whose close() is atomic at the OS level.  The fallback backend writes to
      // IndexedDB which is also atomic.
      const commit = async () => {
        const preserved = folder.native
          ? await this.files.passthrough(folder, sidecarName)
          : passthrough;
        const writeMetadata = preserved ? undefined : this._metadata.get(assetId);
        // A queued scalar snapshot never rolls back a confirmed removal stack.
        const records = preserved?.unknownAttributes.find(
          (a) => a.name === 'papp:InpaintRemovals',
        )?.value;
        const output = this.serializer.serialize(
          { ...model, inpaintRemovals: records },
          preserved,
          culling,
          writeMetadata,
        );
        if (new RegExp(WORKFLOW_MARKUP_PATTERN, 'u').test(output))
          await this.workflowCore.read(output);
        await this.folderAccess.writeFile(folder, sidecarName, new TextEncoder().encode(output));
        this._rememberWritten(assetId, output, currentSource());
      };
      if (folder.native && navigator.locks) await withRemovalWriteLock(folder, rawFilename, commit);
      else await commit();
      this.saveState.saved(assetId, revision);
    } catch (e) {
      this.saveState.failed(assetId, revision, e);
      console.error(`XmpStoreService: write failed for ${rawFilename}:`, e);
      throw e;
    }
  }

  private _sidecarFilename(rawFilename: string): string {
    return rawFilename.replace(/\.[^.]+$/, '.xmp');
  }
}

/** A failed sidecar must not relinquish its folder while sibling streams remain open. */
async function settleWrites(writes: Iterable<Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(writes);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Sidecar writes failed after all streams settled');
}
