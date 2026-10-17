import { Injectable, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { FolderAccessService } from '../../folder-access/folder-access.service';
import { assertValidSingleFileXmp } from '../../xmp/single-file-xmp.service';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { XmpAdjustmentRestoreService } from '../../xmp/xmp-adjustment-restore.service';
import { XmpStoreService } from '../../xmp/xmp-store.service';
import {
  primarySidecarFilename,
  sameSidecar,
  type HostedSidecarBinding,
} from '../../xmp/sidecar-binding';
import type { XmpCulling } from '../../xmp/xmp.types';
import { PRIMARY_VARIANT_ID } from '../../generated/workflow.generated';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { MapleFolderHandle } from '../../folder-access/folder-access.types';
import type { Asset, AssetId } from '../../models/asset';
import { batchSidecarTarget, type BatchOperation, type PreparedBatchPatch } from './batch-ledger';
import {
  buildTransferPatch,
  snapWhiteBalanceBaseline,
  type WhiteBalanceBaseline,
} from './adjustment-transfer';

@Injectable({ providedIn: 'root' })
export class BatchSyncAssetIO {
  private readonly library = inject(LibraryStateService);
  private readonly store = inject(LibraryStore);
  private readonly files = inject(FolderAccessService);
  private readonly parser = inject(XmpParserService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly xmpStore = inject(XmpStoreService);
  private readonly restore = inject(XmpAdjustmentRestoreService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  private readonly identities = new WeakMap<MapleFolderHandle, Promise<string>>();

  identity(folder: MapleFolderHandle): Promise<string> {
    const cached = this.identities.get(folder);
    if (cached) return cached;
    const identity = (async () => {
      if (folder.native) return folder.persistedKey ?? folder.name;
      const originals = (folder.fallbackFiles ?? []).filter(
        (f) => !f.name.toLowerCase().endsWith('.xmp'),
      );
      const text =
        folder.name +
        JSON.stringify(
          originals.map((f) => [f.webkitRelativePath || f.name, f.size, f.lastModified]).sort(),
        );
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return (
        'fallback:' + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
      );
    })();
    this.identities.set(folder, identity);
    return identity;
  }

  private assetId(operation: BatchOperation, id: string): AssetId {
    const name = operation.assetNames[id];
    const candidate =
      this.store.findAsset(id) ?? this.library.assets().find((a) => a.filename === name);
    if (!candidate || candidate.filename !== name)
      throw new Error('This photo is missing from the reopened batch folder.');
    return candidate.id;
  }

  // BatchPreviewService resolves this decoder-bearing adapter lazily.
  // fallow-ignore-next-line unused-class-member
  async model(id: AssetId): Promise<AdjustmentModel> {
    const live = this.store.adjustmentModels().get(id);
    if (live) return structuredClone(live);
    if (this.library.backend === 'self-hosted') {
      const sidecar = await this.restore.loadForWrite(id);
      if (sidecar) this.store.restoreAdjustment(id, sidecar.model);
    }
    if (this.library.backend === 'self-hosted')
      return structuredClone(this.library.adjustmentFor(id)());
    const asset = this.store.findAsset(id);
    const folder = this.library.currentFolder();
    if (!asset || !folder) throw new Error('Open the source photo’s folder to read its settings.');
    const xml = await this.readSidecar(folder, primarySidecarFilename(asset.filename));
    return {
      ...defaultAdjustmentModel(),
      ...(xml === undefined ? {} : this.parser.parseAdjustmentModel(xml).model),
    };
  }

  /** The ledger fixed this target's sidecar at creation; the live asset must still be that file (#4682). */
  private binding(
    operation: BatchOperation,
    id: string,
    folder: MapleFolderHandle,
    rawFilename: string,
  ): HostedSidecarBinding {
    const target = batchSidecarTarget(operation, id);
    if (
      target.rawFilename !== rawFilename ||
      target.variantId !== PRIMARY_VARIANT_ID ||
      target.filename !== primarySidecarFilename(rawFilename)
    )
      throw new Error(
        'This batch was prepared for a different sidecar. Copy settings again to replace them.',
      );
    return { folder, ...target };
  }

  private async readSidecar(
    folder: MapleFolderHandle,
    sidecarName: string,
  ): Promise<string | undefined> {
    try {
      const xml = new TextDecoder().decode(await this.files.readFile(folder, sidecarName));
      assertValidSingleFileXmp(xml);
      return xml;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
      throw error;
    }
  }

  async baseline(id: AssetId): Promise<WhiteBalanceBaseline> {
    if (this.library.backend === 'self-hosted') {
      const path = this.store.absPathFor(id);
      if (!path) throw new Error('Reopen the source photo in its registered library.');
      return firstValueFrom(
        this.http.get<WhiteBalanceBaseline>(`${this.base}/jobs/batch-baseline`, {
          params: { path },
        }),
      );
    }
    const asset = this.store.findAsset(id);
    if (!asset) throw new Error('Reopen the source photo to read its camera white balance.');
    // Use the established decoder, sequentially and at a tiny output size.
    // Decode metadata still comes from the original camera calibration.
    const bytes = await this.library.bytesForAsset(id);
    const result = await this.pipeline.decode(
      bytes.slice(),
      asset.filename.split('.').pop() ?? '',
      undefined,
      16,
      true,
    );
    const baseline = snapWhiteBalanceBaseline({
      temperature: result.asShotTemperature,
      tint: result.asShotTint,
    });
    if (
      !Number.isFinite(baseline.temperature) ||
      baseline.temperature <= 0 ||
      !Number.isFinite(baseline.tint)
    )
      throw new Error('This photo has no readable as-shot white balance.');
    return baseline;
  }

  async validate(operation: BatchOperation, id: string): Promise<void> {
    const folder = this.library.currentFolder();
    if (!folder?.write)
      throw new Error('Reopen the batch folder with write access before resuming.');
    if (operation.directory) {
      if (!folder.native || !(await folder.native.isSameEntry(operation.directory)))
        throw new Error('Open the original batch folder before resuming.');
    } else if ((await this.identity(folder)) !== operation.libraryId) {
      throw new Error('Open the original batch library before resuming.');
    }
    this.assetId(operation, id);
  }

  async prepare(operation: BatchOperation, id: string): Promise<PreparedBatchPatch> {
    await this.validate(operation, id);
    const patch = await this.transferPatch(operation, id);
    await this.library.flushPendingXmpWrites();
    const asset = this.store.findAsset(this.assetId(operation, id))!;
    const folder = this.library.currentFolder()!;
    const xml = await this.readSidecar(
      folder,
      this.binding(operation, id, folder, asset.filename).filename,
    );
    const current = {
      ...defaultAdjustmentModel(),
      ...(xml === undefined ? {} : this.parser.parseAdjustmentModel(xml).model),
    };
    const canonicalAfter = {
      ...defaultAdjustmentModel(),
      ...this.parser.parseAdjustmentModel(this.serializer.serialize({ ...current, ...patch }))
        .model,
    };
    const selected = (model: AdjustmentModel) =>
      Object.fromEntries(
        (Object.keys(patch) as (keyof AdjustmentModel)[]).map((key) => [
          key,
          structuredClone(model[key]),
        ]),
      );
    return { patch, before: selected(current), after: selected(canonicalAfter) };
  }

  private async transferPatch(
    operation: BatchOperation,
    id: string,
  ): Promise<Partial<AdjustmentModel>> {
    if (!operation.request) {
      if (!operation.patch) throw new Error('Saved batch has no settings.');
      return structuredClone(operation.patch);
    }
    const baseline =
      operation.request.relativeWhiteBalance && operation.request.groups.includes('white_balance')
        ? await this.baseline(this.assetId(operation, id))
        : undefined;
    return buildTransferPatch(operation.request, baseline);
  }

  async write(operation: BatchOperation, id: string, prepared: PreparedBatchPatch): Promise<void> {
    // The main thread owns file I/O. Its lock outlives a failed/replaced Worker,
    // so a second tab cannot race the first tab's last sidecar close.
    const write = () => this.writeConfirmed(operation, id, prepared);
    if (navigator.locks) await navigator.locks.request('maple-batch-sidecar-write', write);
    else await write(); // Node's real-filesystem integration harness has no Web Locks.
  }

  private async writeConfirmed(
    operation: BatchOperation,
    id: string,
    prepared: PreparedBatchPatch,
  ): Promise<void> {
    await this.validate(operation, id);
    const currentId = this.assetId(operation, id);
    const asset = this.store.findAsset(currentId)!;
    const folder = this.library.currentFolder()!;
    const binding = this.binding(operation, id, folder, asset.filename);
    // While the editor holds a sibling variant for this asset, the live model
    // is that sibling's; the Primary is written without touching it.
    const liveNow = () =>
      sameSidecar(this.xmpStore.bindingFor(currentId, folder, asset.filename), binding);
    const live = liveNow();
    const target = await this.readTarget(currentId, folder, binding.filename, live);
    // A variant selected during the read owns the live model from here on; the
    // Primary document read above must not be merged into it.
    if (liveNow() !== live)
      throw new Error(
        'The selected variant changed while this batch was writing. Copy settings again to replace them.',
      );
    assertPreparedStillApplies(target.current, prepared);
    if (live) this.mergeLiveTarget(currentId, target, prepared.patch);
    await this.xmpStore.writeBound(
      currentId,
      binding,
      live ? this.library.adjustmentFor(currentId)() : { ...target.current, ...prepared.patch },
      live ? cullingOf(this.store.findAsset(currentId)!) : (target.culling ?? EMPTY_CULLING),
      { passthrough: target.parsed?.passthrough, metadata: target.parsed?.metadata },
    );
  }

  /** Flush pending edits, then read the authoritative target sidecar. An unreadable
   * existing sidecar is a recorded failure, never a license to write a default over it. */
  private async readTarget(
    currentId: AssetId,
    folder: MapleFolderHandle,
    sidecarName: string,
    live: boolean,
  ): Promise<TargetDocument> {
    await this.library.flushPendingXmpWrites();
    const beforeRead = structuredClone(this.library.adjustmentFor(currentId)());
    const xml = await this.readSidecar(folder, sidecarName);
    const parsed = xml === undefined ? undefined : this.parser.parseAdjustmentModel(xml);
    const model = { ...defaultAdjustmentModel(), ...parsed?.model };
    // A user can keep editing while the filesystem read is in flight. Fold
    // those new fields over the disk base before applying the selected group.
    const authoredDuringRead = live
      ? changedFields(beforeRead, this.library.adjustmentFor(currentId)())
      : {};
    return {
      parsed,
      model,
      authoredDuringRead,
      current: { ...model, ...authoredDuringRead },
      culling: xml === undefined ? undefined : this.parser.parseCulling(xml),
    };
  }

  private mergeLiveTarget(
    currentId: AssetId,
    target: TargetDocument,
    patch: Partial<AdjustmentModel>,
  ): void {
    this.store.mergePersistedAdjustment(currentId, target.model, target.authoredDuringRead);
    if (target.culling) this.store.mergePersistedCulling(currentId, target.culling);
    this.xmpStore.replacePassthroughs(
      [currentId],
      target.parsed ? new Map([[currentId, target.parsed.passthrough]]) : new Map(),
      target.parsed ? new Map([[currentId, target.parsed.metadata]]) : new Map(),
    );
    this.library.updateAdjustment(currentId, patch);
  }
}

interface TargetDocument {
  parsed?: ReturnType<XmpParserService['parseAdjustmentModel']>;
  model: AdjustmentModel;
  authoredDuringRead: Partial<AdjustmentModel>;
  current: AdjustmentModel;
  culling?: XmpCulling;
}

function changedFields(before: AdjustmentModel, after: AdjustmentModel): Partial<AdjustmentModel> {
  return Object.fromEntries(
    (Object.keys(after) as (keyof AdjustmentModel)[])
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => [key, structuredClone(after[key])]),
  );
}

function assertPreparedStillApplies(current: AdjustmentModel, prepared: PreparedBatchPatch): void {
  const matches = (expected: Partial<AdjustmentModel>) =>
    (Object.keys(prepared.patch) as (keyof AdjustmentModel)[]).every(
      (key) => JSON.stringify(current[key]) === JSON.stringify(expected[key]),
    );
  if (!matches(prepared.before) && !matches(prepared.after))
    throw new Error(
      'Selected settings changed after this batch was prepared. Copy settings again to replace them.',
    );
}

const EMPTY_CULLING: XmpCulling = { rating: 0, flag: 'unflagged', colorLabel: null, keywords: [] };
function cullingOf(asset: Asset): XmpCulling {
  return {
    rating: asset.rating,
    flag: asset.flag,
    colorLabel: asset.colorLabel,
    keywords: asset.keywords ?? [],
  };
}
