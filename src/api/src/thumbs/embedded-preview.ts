import { rename, rm } from 'node:fs/promises';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { UnsupportedCameraError } from '../ffi/unsupported-camera.ts';
import { THUMB_LONG_EDGE_PX } from './render.ts';

/** 512: extraction never upscales, so the extracted long edge is min(embedded, tier)
 * and reaches 512 exactly when the embedded preview does, for both tiers. */
const EMBEDDED_PREVIEW_MIN_LONG_EDGE_PX = THUMB_LONG_EDGE_PX;

const HEADER_BYTES = 16 * 1024;
const ISPE_BOX_BYTES = 20;

/** Long edge of an AVIF from its `ispe` (image spatial extents) box alone, so
 * the API process never decodes pixels. Null when the header has no such box. */
export async function avifLongEdgePx(avifPath: string): Promise<number | null> {
  const header = await Bun.file(avifPath)
    .slice(0, HEADER_BYTES)
    .arrayBuffer()
    .then((bytes) => Buffer.from(bytes))
    .catch(() => null);
  const type = header?.indexOf('ispe') ?? -1;
  if (!header || type < 4 || type + 16 > header.length) return null;
  if (header.readUInt32BE(type - 4) !== ISPE_BOX_BYTES) return null;
  return Math.max(header.readUInt32BE(type + 8), header.readUInt32BE(type + 12));
}

function extractionFailure(
  rawPath: string,
  outPath: string,
  maxPx: number,
  quality: number,
): Promise<string | null> {
  return ffiPool()
    .renderThumbnailAvifToFile(rawPath, outPath, maxPx, quality)
    .then(
      (extracted) => (extracted ? null : 'extraction returned false'),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
}

export async function renderEmbeddedOrDeveloped(
  rawPath: string,
  outPath: string,
  maxPx: number,
  quality: number,
  develop: (reason: string) => Promise<boolean>,
): Promise<boolean> {
  const failure = await extractionFailure(rawPath, outPath, maxPx, quality);
  if (failure !== null) return develop(failure);
  const longEdge = await avifLongEdgePx(outPath);
  if (longEdge === null || longEdge >= EMBEDDED_PREVIEW_MIN_LONG_EDGE_PX) return true;

  const aside = `${outPath}.embedded`;
  await rename(outPath, aside);
  try {
    const developed = await develop(
      `embedded preview is ${longEdge}px, below the ${EMBEDDED_PREVIEW_MIN_LONG_EDGE_PX}px minimum`,
    ).catch((error: unknown) => {
      if (error instanceof UnsupportedCameraError) return false;
      throw error;
    });
    if (developed) return true;
    await rename(aside, outPath);
    return true;
  } finally {
    await rm(aside, { force: true });
  }
}
