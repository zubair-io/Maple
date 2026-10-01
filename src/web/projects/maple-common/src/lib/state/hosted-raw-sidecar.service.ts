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
import { hasXmlParseError } from '../xmp/xmp-dom-utils';
import { XmpParserService } from '../xmp/xmp-parser.service';
import type { PreviewLocation } from './preview-location';

/** Cold RAW derivatives use the actual authored sidecar, including its film LUT.
 * Missing sidecars permit embedded extraction; all other failures stay failures. */
@Injectable({ providedIn: 'root' })
export class HostedRawSidecarService {
  private readonly folders = inject(FolderAccessService);
  private readonly parser = inject(XmpParserService);
  private readonly films = inject(FilmLutService);
  private readonly injector = inject(Injector);

  async read(folder: MapleFolderHandle, location: PreviewLocation): Promise<string | null> {
    const basename = location.filename.replace(/\.[^.]+$/, '.xmp');
    const path = location.dir ? `${location.dir}/${basename}` : basename;
    let bytes: Uint8Array;
    try {
      bytes = await this.folders.readFile(folder, path);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    // Chromium may keep the input's root and append parsererror underneath it.
    if (hasXmlParseError(document) || document.getElementsByTagName('parsererror').length > 0) {
      throw new Error(`Malformed RAW sidecar: ${path}`);
    }
    return xml;
  }

  async develop(bytes: Uint8Array, ext: string, xml: string): Promise<Blob> {
    const { model } = this.parser.parseAdjustmentModel(xml);
    const film = await this.films.getLattice(model.filmLook ?? '');
    const image = await this.injector
      .get(RawPipelineService)
      .decode(bytes, ext, xml, PREVIEW_LONG_EDGE_PX, true, film ?? undefined);
    return (await encodeDevelopedRenderToAvif(image)) ?? encodeDevelopedRenderToJpeg(image);
  }
}
