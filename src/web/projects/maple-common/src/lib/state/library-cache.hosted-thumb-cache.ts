import { Injectable, inject } from '@angular/core';
import type { Asset } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { hostedSidecarFingerprint } from '../maple-cache/hosted-sidecar-fingerprint';
import type { ThumbFormat } from '../raw-pipeline/image-utils';
import { HostedSidecarFreshnessService } from '../xmp/hosted-sidecar-freshness.service';
import { primarySidecarFilename } from '../xmp/sidecar-binding';
import { HostedSidecarErrors } from './hosted-sidecar-errors.service';
import { previewLocation, type PreviewLocation } from './preview-location';

@Injectable({ providedIn: 'root' })
export class HostedThumbCache {
  private readonly cache = inject(MapleCacheService);
  private readonly sidecars = inject(HostedSidecarFreshnessService);
  private readonly errors = inject(HostedSidecarErrors);

  async read(folder: MapleFolderHandle, asset: Asset): Promise<Blob | null> {
    const location = previewLocation(asset.id);
    const fingerprint = location
      ? await hostedSidecarFingerprint(await this._currentSidecar(folder, location))
      : undefined;
    return this.cache.readThumb(folder, asset.filename, fingerprint);
  }

  snapshot(folder: MapleFolderHandle, asset: Asset): Promise<string | null | undefined> {
    const location = previewLocation(asset.id);
    return location && !this.errors.errors().has(asset.id)
      ? this._currentSidecar(folder, location)
      : Promise.resolve(undefined);
  }

  async writeIfCurrent(
    folder: MapleFolderHandle,
    asset: Asset,
    blob: Blob,
    format: ThumbFormat,
    sidecarBefore: string | null | undefined,
  ): Promise<boolean> {
    if (!folder.write || this.errors.errors().has(asset.id)) return false;
    const location = previewLocation(asset.id);
    if (location && sidecarBefore !== (await this._currentSidecar(folder, location))) return false;
    await this.cache.writeThumb(
      folder,
      asset.filename,
      blob,
      format,
      sidecarBefore === undefined ? undefined : await hostedSidecarFingerprint(sidecarBefore),
    );
    return true;
  }

  private _currentSidecar(
    folder: MapleFolderHandle,
    location: PreviewLocation,
  ): Promise<string | null> {
    const path = [location.dir, primarySidecarFilename(location.filename)]
      .filter(Boolean)
      .join('/');
    return this.sidecars.readCurrent(folder, path);
  }
}
