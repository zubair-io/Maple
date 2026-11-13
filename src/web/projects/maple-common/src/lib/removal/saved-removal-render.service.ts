import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { DecodedImage } from '../raw-pipeline/raw-pipeline.types';
// Normal local-folder rendering consumes durable sidecars and companions (#3955).
import { Injectable, Injector, inject } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import { LibraryStateService } from '../state/library-state.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { LocalRemovalAssets } from './local-removal-assets';
import type { RemovalCompanionBundle } from './removal-companion-bundle';
import { savedRemovalRecords } from './saved-removal-records';

@Injectable({ providedIn: 'root' })
export class SavedRemovalRenderService {
  private readonly pipeline = inject(RawPipelineService);
  private readonly library = inject(LibraryStateService);
  private readonly files = inject(FolderAccessService);
  private readonly sidecars = inject(XmpStoreService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly injector = inject(Injector);

  /** Unknown record attributes are part of the render recipe, just as on disk. */
  serialize(assetId: AssetId | null, model: AdjustmentModel): string {
    return this.serializer.serialize(
      model,
      assetId ? this.sidecars.passthroughFor(assetId) : undefined,
    );
  }

  render(
    assetId: AssetId,
    bytes: Uint8Array,
    ext: string,
    xml: string,
    cap: number,
    preview: boolean,
    film?: ArrayBuffer,
  ): Promise<DecodedImage> {
    const records = savedRemovalRecords(xml);
    if (!records) {
      this.pipeline.savedPreview.close();
      return this.pipeline.decode(bytes, ext, xml, cap, preview, film);
    }
    return this.pipeline.savedPreview.render(
      { sourceId: String(assetId), bytes, ext },
      records,
      xml,
      async () => {
        const bundle = await this.load(assetId, xml);
        if (!bundle) throw new Error('Saved removal records changed while preparing the preview');
        return bundle;
      },
      cap,
      film,
    );
  }

  /** Cold preparation only. No file read, hashing or bundling belongs on a slider tick. */
  async load(assetId: AssetId, xml: string): Promise<RemovalCompanionBundle | undefined> {
    const records = savedRemovalRecords(xml);
    if (!records) return undefined;
    const asset = this.library.focusedAsset();
    const folder = this.library.currentFolder();
    const server = this.library.backend === 'self-hosted';
    const path = server ? this.library.absPathFor(assetId) : undefined;
    if (!asset || asset.id !== assetId || (server ? !path : !folder)) {
      throw new Error('Reopen the photo’s containing folder to load its saved removal companions.');
    }
    const assets = server
      ? await import('./server-removal-assets').then(({ openServerRemovalAssets }) =>
          openServerRemovalAssets(this.injector, path!, () => this.library.bytesForAsset(assetId)),
        )
      : new LocalRemovalAssets(this.files, folder!, asset.filename);
    const bundle = await assets.readBundle(records);
    if (
      this.library.focusedAsset()?.id !== assetId ||
      (server ? this.library.absPathFor(assetId) !== path : this.library.currentFolder() !== folder)
    ) {
      throw new DOMException('Saved removal preparation superseded', 'AbortError');
    }
    return bundle;
  }
}
