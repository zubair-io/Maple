import { Injectable, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { FolderAccessService } from '../../folder-access/folder-access.service';
import { assertValidSingleFileXmp } from '../../xmp/single-file-xmp.service';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { XmpAdjustmentRestoreService } from '../../xmp/xmp-adjustment-restore.service';
import { XmpStoreService } from '../../xmp/xmp-store.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { MapleFolderHandle } from '../../folder-access/folder-access.types';
import type { AssetId } from '../../models/asset';
import type { BatchOperation, PreparedBatchPatch } from './batch-ledger';
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
    const xml = await this.readSidecar(folder, asset.filename);
    return {
      ...defaultAdjustmentModel(),
      ...(xml === undefined ? {} : this.parser.parseAdjustmentModel(xml).model),
    };
  }

  private async readSidecar(
    folder: MapleFolderHandle,
    filename: string,
  ): Promise<string | undefined> {
    try {
      const xml = new TextDecoder().decode(
        await this.files.readFile(folder, filename.replace(/\.[^.]+$/, '.xmp')),
      );
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
    const xml = await this.readSidecar(this.library.currentFolder()!, asset.filename);
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
    // Flush any edit the user made while the worker was preparing this item.
    // Then read the authoritative target sidecar, including unknown XML and
    // culling. An unreadable existing sidecar is a recorded failure, never a
    // license to write a default document over it.
    await this.library.flushPendingXmpWrites();
    const beforeRead = structuredClone(this.library.adjustmentFor(currentId)());
    const xml = await this.readSidecar(folder, asset.filename);
    const parsed = xml === undefined ? undefined : this.parser.parseAdjustmentModel(xml);
    const model = { ...defaultAdjustmentModel(), ...parsed?.model };
    // A user can keep editing while the filesystem read is in flight. Fold
    // those new fields over the disk base before applying the selected group.
    const afterRead = this.library.adjustmentFor(currentId)();
    const authoredDuringRead = Object.fromEntries(
      (Object.keys(afterRead) as (keyof AdjustmentModel)[])
        .filter((key) => JSON.stringify(beforeRead[key]) !== JSON.stringify(afterRead[key]))
        .map((key) => [key, structuredClone(afterRead[key])]),
    );
    const current = { ...model, ...authoredDuringRead };
    const matches = (expected: Partial<AdjustmentModel>) =>
      (Object.keys(prepared.patch) as (keyof AdjustmentModel)[]).every(
        (key) => JSON.stringify(current[key]) === JSON.stringify(expected[key]),
      );
    if (!matches(prepared.before) && !matches(prepared.after))
      throw new Error(
        'Selected settings changed after this batch was prepared. Copy settings again to replace them.',
      );
    this.store.mergePersistedAdjustment(currentId, model, authoredDuringRead);
    if (xml !== undefined)
      this.store.mergePersistedCulling(currentId, this.parser.parseCulling(xml));
    this.xmpStore.replacePassthroughs(
      [currentId],
      parsed ? new Map([[currentId, parsed.passthrough]]) : new Map(),
    );
    if (xml !== undefined)
      this.xmpStore.rememberMetadata(currentId, this.parser.parseMetadata(xml));
    this.library.updateAdjustment(currentId, prepared.patch);
    await this.library.flushSidecarWrite(currentId);
  }
}
