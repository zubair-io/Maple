// XmpStoreService — P6.
//
// Coordinates debounced, atomic sidecar writes for the Develop tab.
//
// - scheduleWrite()     debounces at 150ms then atomically writes the sidecar via
//                       FolderAccessService (FS Access writable-stream close is
//                       atomic on Chromium; fallback backend writes to IndexedDB).
// - rememberPassthrough stores the passthrough bucket from the last load so that
//                       subsequent writes can reproduce unknown content verbatim.
// - flushAll()          cancels all pending timers (call on beforeunload).

import { Injectable, inject } from '@angular/core';
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
import { WorkflowVariantStoreService } from './workflow-variant-store.service';
import {
  PRIMARY_VARIANT_ID,
  WORKFLOW_MARKUP_PATTERN,
  type SidecarWorkflow,
} from '../generated/workflow.generated';

export interface HostedSidecarBinding {
  readonly folder: MapleFolderHandle;
  readonly rawFilename: string;
  readonly filename: string;
  readonly variantId: string;
}
import { hasXmlParseError } from './xmp-dom-utils';
import { withRemovalWriteLock } from '../removal/removal-write-lock';

@Injectable({ providedIn: 'root' })
export class XmpStoreService {
  private folderAccess = inject(FolderAccessService);
  private serializer = inject(XmpSerializerService);
  private saveState = inject(SidecarSaveStateService);
  private readonly workflowCore = inject(WorkflowXmpService);
  private readonly parser = inject(XmpParserService);
  private readonly hostedWriter = inject(HostedWorkflowWriterService);
  private readonly variants = inject(WorkflowVariantStoreService);
  private readonly latestModels = new WeakMap<MapleFolderHandle, Map<AssetId, AdjustmentModel>>();
  private readonly bindings = new Map<AssetId, HostedSidecarBinding>();
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

  /** Pending debounce handles keyed by AssetId. */
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
  /** Publish workflow metadata through the same per-asset atomic write chain.
   * Requires an existing sidecar; the caller commits initial adjustments first. */
  // Browser workflow gate calls this through a nested handler; product controls follow #2437.
  // fallow-ignore-next-line unused-class-member
  async writeWorkflow(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    workflow: SidecarWorkflow,
  ): Promise<void> {
    if (!folder.write) throw new Error('Reopen this folder with write access.');
    if (this._pendingWrites.has(assetId)) await this.flushAsset(assetId);
    const prior = this._inFlightWrites.get(assetId) ?? Promise.resolve();
    const write = prior
      .then(async () => {
        const publish = async () => {
          if (workflow.variantId !== 'primary')
            throw Error('Variant identity does not match the primary sidecar.');
          const name = this._sidecarFilename(rawFilename);
          const xml = new TextDecoder('utf-8', { fatal: true }).decode(
            await this.folderAccess.readFile(folder, name),
          );
          const existing = await this.workflowCore.read(xml);
          if ((existing?.variantId ?? 'primary') !== 'primary')
            throw Error('Variant identity does not match the primary sidecar.');
          const output = await this.workflowCore.embed(workflow, xml);
          await this.folderAccess.writeFile(folder, name, new TextEncoder().encode(output));
          this._passthroughs.set(assetId, this.parser.parseAdjustmentModel(output).passthrough);
        };
        if (folder.native && navigator.locks)
          await navigator.locks.request('maple-workflow-variant:primary', publish);
        else await publish();
      })
      .finally(() => {
        if (this._inFlightWrites.get(assetId) === write) this._inFlightWrites.delete(assetId);
      });
    this._inFlightWrites.set(assetId, write);
    await write;
  }

  /** Latest serialized write chain for each asset. */
  private readonly _inFlightWrites = new Map<AssetId, Promise<void>>();

  /** Per-asset passthrough buckets loaded from the source sidecar. */
  private _passthroughs = new Map<AssetId, PassthroughBucket>();
  private readonly _metadata = new Map<AssetId, XmpMetadata>();

  rememberMetadata(assetId: AssetId, metadata: XmpMetadata): void {
    this._metadata.set(assetId, metadata);
  }

  // ── Passthrough cache ───────────────────────────────────────────────────────

  /**
   * Store a passthrough bucket for an asset that was loaded externally
   * (e.g. when LibraryStateService calls the parser directly).
   */
  rememberPassthrough(assetId: AssetId, passthrough: PassthroughBucket): void {
    this._passthroughs.set(assetId, passthrough);
  }

  /**
   * Replace passthrough state for a freshly enumerated asset scope.
   *
   * Folder reopen uses this as one commit step after every sidecar has been
   * read. Deleting the complete scope first prevents a missing or removed
   * sidecar from inheriting unknown XML loaded during an earlier open.
   */
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
  }

  /**
   * Look up the passthrough bucket previously stored for an asset (or undefined
   * if none was ever loaded). Used by callers that bypass `loadSidecar` /
   * `scheduleWrite` (e.g. the Self-Hosted API path in LibraryStateService).
   */
  passthroughFor(assetId: AssetId): PassthroughBucket | undefined {
    return this._passthroughs.get(assetId);
  }

  metadataFor(assetId: AssetId): XmpMetadata | undefined {
    return this._metadata.get(assetId);
  }

  /** Settle the old immutable writer before adopting the selected file (#4063). */
  async bindVariant(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    variantId: string,
    currentSource: () => boolean = () => true,
  ) {
    this.requireVariantAccess(folder);
    await this.settleAsset(assetId);
    const primary = this._sidecarFilename(rawFilename);
    const filename = await this.workflowCore.variantFilename(primary, variantId);
    const xml = await this.variants.read(folder, primary, variantId);
    if (!currentSource()) throw Error('The editor source changed while loading this variant.');
    this.bindings.set(assetId, { folder, rawFilename, filename, variantId });
    this.latestModels.get(folder)?.delete(this.modelKey(assetId, variantId));
    return this.adoptVariantDocument(assetId, xml);
  }

  private requireVariantAccess(folder: MapleFolderHandle): void {
    if (!folder.native || !folder.write || !navigator.locks)
      throw Error('Reopen this folder with filesystem write access before selecting a variant.');
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
    const selected = this.bindings.get(assetId);
    return selected?.folder === folder && selected.rawFilename === rawFilename
      ? selected
      : {
          folder,
          rawFilename,
          filename: this._sidecarFilename(rawFilename),
          variantId: PRIMARY_VARIANT_ID,
        };
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Schedule a debounced sidecar write for `assetId`.
   * If a write is already pending for this asset, it is cancelled and replaced.
   * Does nothing when the folder has no write permission.
   */
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

  /** Settle this asset's real atomic write before a batch records success. */
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

  /** Confirmed complete-document actions use the same asset write queue. */
  async publishWorkflow(
    assetId: AssetId,
    publish: () => Promise<string>,
    currentSource: () => boolean,
  ): Promise<string> {
    await this.settleAsset(assetId);
    const revision = this.saveState.queued(assetId);
    const prior = this._inFlightWrites.get(assetId) ?? Promise.resolve();
    const write = prior.then(async () => {
      this.saveState.saving(assetId, revision);
      try {
        const output = await publish();
        if (currentSource()) {
          const parsed = this.parser.parseAdjustmentModel(output);
          this.rememberPassthrough(assetId, parsed.passthrough);
          this.rememberMetadata(assetId, parsed.metadata);
        }
        this.saveState.saved(assetId, revision);
        return output;
      } catch (error) {
        this.saveState.failed(assetId, revision, error);
        throw error;
      }
    });
    const barrier = write.then(
      () => undefined,
      () => undefined,
    );
    this._inFlightWrites.set(assetId, barrier);
    try {
      return await write;
    } finally {
      if (this._inFlightWrites.get(assetId) === barrier) this._inFlightWrites.delete(assetId);
    }
  }

  /** Commit after immutable companion publication; failure never reports Saved. */
  async writeRemovalConfirmed(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    expectedRecords: string,
    records: string,
  ): Promise<void> {
    const pending = this._pendingWrites.get(assetId);
    if (pending) clearTimeout(pending.timeout);
    this._pendingWrites.delete(assetId);
    const revision = this.saveState.queued(assetId);
    const prior = this._inFlightWrites.get(assetId) ?? Promise.resolve();
    const write = prior
      .catch(() => undefined)
      .then(async () => {
        this.saveState.saving(assetId, revision);
        try {
          const { LocalRemovalAssets } = await import('../removal/local-removal-assets');
          const assets = new LocalRemovalAssets(this.folderAccess, folder, rawFilename);
          await withRemovalWriteLock(folder, rawFilename, async () => {
            const source = await this.sourcePassthrough(folder, rawFilename);
            const current =
              source?.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value ??
              '[]';
            if (current !== expectedRecords)
              throw new Error('The photo changed before this removal could be saved.');
            await assets.verifySource(records);
            await assets.read(records);
            const passthrough: PassthroughBucket = {
              ...source,
              unknownAttributes: [
                ...(source?.unknownAttributes ?? []).filter(
                  (a) => a.name !== 'papp:InpaintRemovals',
                ),
                { name: 'papp:InpaintRemovals', value: records },
              ],
              unknownNodes: source?.unknownNodes ?? [],
            };
            const xml = this.serializer.serialize(model, passthrough, culling);
            await this.folderAccess.writeFile(
              folder,
              this._sidecarFilename(rawFilename),
              new TextEncoder().encode(xml),
            );
            const reopened = await this.sourcePassthrough(folder, rawFilename);
            if (
              reopened?.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value !==
              records
            ) {
              throw new Error('Removal sidecar verification failed.');
            }
            this._passthroughs.set(assetId, passthrough);
          });
          this.saveState.saved(assetId, revision);
        } catch (error) {
          this.saveState.failed(assetId, revision, error);
          throw error;
        }
      })
      .finally(() => {
        if (this._inFlightWrites.get(assetId) === write) this._inFlightWrites.delete(assetId);
      });
    this._inFlightWrites.set(assetId, write);
    return write;
  }

  // ── Flush all (beforeunload) ────────────────────────────────────────────────

  /**
   * Cancel all pending timers.
   * Call from a beforeunload handler — modern Chromium will still finish any
   * in-flight writable-stream operations that have already been flushed to
   * the OS, but pending debounce timers that haven't fired yet are lost.
   * For the common case (user pauses, then closes tab) the 150ms debounce means
   * the write will already have fired before unload.
   */
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
    await Promise.all(new Set([...this._inFlightWrites.values(), ...writes]));
    await Promise.all(
      [...this.retryWrites.values()].flatMap((scope) => scope.map((write) => write.run())),
    );
  }

  // ── Private ─────────────────────────────────────────────────────────────────

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
        const output = await this.hostedWriter.write(
          folder,
          sidecarName,
          model,
          culling,
          currentPassthrough,
          metadata,
          binding.variantId,
        );
        if (currentSource())
          this._passthroughs.set(assetId, this.parser.parseAdjustmentModel(output).passthrough);
        this.saveState.saved(assetId, revision);
        return;
      }
      if (new RegExp(WORKFLOW_MARKUP_PATTERN, 'u').test(xml)) await this.workflowCore.read(xml);
      // FolderAccessService.writeFile uses FS Access writable-stream on Chromium,
      // whose close() is atomic at the OS level.  The fallback backend writes to
      // IndexedDB which is also atomic.
      const commit = async () => {
        const preserved = folder.native
          ? await this.sourcePassthrough(folder, rawFilename)
          : passthrough;
        const metadata = preserved ? undefined : this._metadata.get(assetId);
        const xml = this.serializer.serialize(model, preserved, culling, metadata);
        await this.folderAccess.writeFile(
          folder,
          this._sidecarFilename(rawFilename),
          new TextEncoder().encode(xml),
        );
        if (preserved) this._passthroughs.set(assetId, preserved);
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

  private async sourcePassthrough(
    folder: MapleFolderHandle,
    rawFilename: string,
  ): Promise<PassthroughBucket | undefined> {
    try {
      const bytes = await this.folderAccess.readFile(folder, this._sidecarFilename(rawFilename));
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (hasXmlParseError(new DOMParser().parseFromString(xml, 'application/xml'))) {
        throw new Error('Cannot replace a malformed photo sidecar.');
      }
      return this.parser.parseAdjustmentModel(xml).passthrough;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
      throw error;
    }
  }
}
