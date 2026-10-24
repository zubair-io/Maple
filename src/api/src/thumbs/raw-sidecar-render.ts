import { randomUUID } from 'node:crypto';
import { readFile, rm } from '../fs/mirrored.ts';
import { SaxesParser } from 'saxes';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { filmLutDirectory } from '../ffi/film-lut-directory.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { renderImageThumbToFileViaPool } from './bitmap-pool.ts';

/** The decoder cannot develop a source whose sidecar carries authored edits.
 * Thrown instead of falling back to camera-original pixels. */
export class AuthoredSidecarRenderError extends Error {
  override readonly name = 'AuthoredSidecarRenderError';
  constructor(rawPath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot develop the authored edits for ${rawPath}: ${reason}`, { cause });
  }
}

/** Only the decoder refusing the source is a property of the asset; a crashed
 * child, a full disk or a missing LUT directory stays a server fault. */
function isUnsupportedSource(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('unsupported RAW format');
}

/** Cold-cache RAW regeneration. Null means there is no sidecar, or one whose
 * adjustments are all default (a 0-byte file, empty RDF or metadata only), so
 * the caller renders exactly as for a sidecarless RAW. A sidecar with authored
 * adjustments must develop, with no fallthrough to camera-original pixels. */
export async function renderRawSidecarDerivative(
  rawPath: string,
  outPath: string,
  maxPx: number,
  quality: number,
): Promise<true | null> {
  const xmpPath = xmpSidecarPath(rawPath);
  const xml = await readFile(xmpPath, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (xml === null || xml.length === 0) return null;

  // The native adjustment parser tolerates incomplete XML. Validate the cold
  // read, then pass that exact XML snapshot to the recipe renderer so neither
  // a concurrent save nor a missing film LUT can silently lose edits (#3971, #3976).
  new SaxesParser({ xmlns: true }).write(xml).close();
  if (!(await ffiPool().sidecarHasRenderAdjustments(xml))) return null;
  const snapshotPath = `${outPath}.tmp.develop.${randomUUID()}`;
  const jpegPath = `${snapshotPath}.jpg`;
  try {
    const recipe = { ...DEFAULT_EXPORT_RECIPE, quality: 90, maxLongEdge: maxPx };
    const developed = await ffiPool()
      .exportRecipeToFile(rawPath, xml, JSON.stringify(recipe), await filmLutDirectory(), jpegPath)
      .catch((error: unknown) => {
        throw isUnsupportedSource(error) ? new AuthoredSidecarRenderError(rawPath, error) : error;
      });
    if (!developed) throw new Error(`RAW sidecar develop failed: ${rawPath}`);
    const encoded = await renderImageThumbToFileViaPool(jpegPath, outPath, maxPx, quality, 'jpg');
    if (!encoded.ok) throw new Error(`RAW sidecar AVIF encode failed: ${encoded.error ?? rawPath}`);
    return true;
  } finally {
    await rm(jpegPath, { force: true });
  }
}
