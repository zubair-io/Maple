import { primarySidecarFilename } from '../xmp/sidecar-binding';
import { Injectable, Injector, inject } from '@angular/core';
import { FilmLutService } from '../film/film-lut.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import {
  encodeDevelopedRenderToAvif,
  encodeDevelopedRenderToJpeg,
  PREVIEW_LONG_EDGE_PX,
} from '../raw-pipeline/image-utils';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { readSidecar, sidecarParseFailed } from '../xmp/xmp-dom-utils';
import { XmpParserService } from '../xmp/xmp-parser.service';
import type { PreviewLocation } from './preview-location';
import init, { removal_asset_names } from '../raw-pipeline/pkg/raw_wasm';
import { savedRemovalRecords } from '../removal/saved-removal-records';
import { bundleRemovalCompanions } from '../removal/removal-companion-bundle';
import type { DecodedImage } from '../raw-pipeline/raw-pipeline.types';

/** Cold RAW derivatives use the actual authored sidecar, including its film LUT.
 * Missing or malformed sidecars permit original extraction; the folder listing
 * records malformed sidecars and blocks edits. Other read failures propagate. */
@Injectable({ providedIn: 'root' })
export class HostedRawSidecarService {
  private readonly folders = inject(FolderAccessService);
  private readonly parser = inject(XmpParserService);
  private readonly films = inject(FilmLutService);
  private readonly injector = inject(Injector);

  async read(folder: MapleFolderHandle, location: PreviewLocation): Promise<string | null> {
    const basename = primarySidecarFilename(location.filename);
    const path = location.dir ? `${location.dir}/${basename}` : basename;
    let bytes: Uint8Array;
    try {
      bytes = await this.folders.readFile(folder, path);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    // raw-core rejects a repeated attribute too, so the develop gets the repaired text (#5475).
    const { xml, document } = readSidecar(source);
    if (sidecarParseFailed(document)) {
      // Folder enumeration records the sidecar error and blocks edits. Decode
      // the original RAW so a damaged XMP cannot make the photo disappear.
      return null;
    }
    try {
      this.parser.parseAdjustmentModel(xml);
    } catch {
      return null;
    }
    return xml;
  }

  async render(
    bytes: Uint8Array,
    ext: string,
    xml: string,
    folder: MapleFolderHandle,
    location: PreviewLocation,
    qualityPreview: boolean,
  ): Promise<DecodedImage> {
    const { model } = this.parser.parseAdjustmentModel(xml);
    const film = await this.films.getLattice(model.filmLook ?? '');
    const pipeline = this.injector.get(RawPipelineService);
    const records = savedRemovalRecords(xml);
    if (!records)
      return pipeline.decode(
        bytes,
        ext,
        xml,
        PREVIEW_LONG_EDGE_PX,
        qualityPreview,
        film ?? undefined,
      );
    const directory = location.dir ? `${location.dir}/` : '';
    await init();
    const names = JSON.parse(removal_asset_names(records)) as string[];
    const entries = await Promise.all(
      names.map(
        async (name) =>
          [
            name,
            await this.folders.readFile(folder, `${directory}.maple/inpaint/${name}`),
          ] as const,
      ),
    );
    return pipeline.savedPreview.renderDerivative(
      {
        sourceId: `${folder.persistedKey ?? folder.name}:${directory}${location.filename}`,
        bytes,
        ext,
      },
      xml,
      bundleRemovalCompanions(new Map(entries)),
      PREVIEW_LONG_EDGE_PX,
      film ?? undefined,
    );
  }

  async develop(
    bytes: Uint8Array,
    ext: string,
    xml: string,
    folder: MapleFolderHandle,
    location: PreviewLocation,
  ): Promise<Blob> {
    const image = await this.render(bytes, ext, xml, folder, location, true);
    return (await encodeDevelopedRenderToAvif(image)) ?? encodeDevelopedRenderToJpeg(image);
  }
}
