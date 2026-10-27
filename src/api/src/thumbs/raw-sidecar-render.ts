import { randomUUID } from 'node:crypto';
import { readFile, rm } from '../fs/mirrored.ts';
import { SaxesParser } from 'saxes';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { filmLutDirectory } from '../ffi/film-lut-directory.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { renderImageThumbToFileViaPool } from './bitmap-pool.ts';
import { child as childLogger } from '../log.ts';
import { removeDuplicateAttributes } from '../../../web/projects/maple-common/src/lib/xmp/xmp-duplicate-attributes.ts';

const log = childLogger('thumbs/raw-sidecar-render');
const warnedDuplicateSidecars = new Set<string>();

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

function assertWellFormed(xml: string): void {
  new SaxesParser({ xmlns: true }).write(xml).close();
}

/** A sidecar whose only defect is a repeated attribute (Apple before #4686
 * wrote `papp:FilmLook` twice) develops from its first copies (#5475). Any
 * other malformation keeps its original error; the file is never rewritten. */
function wellFormedSidecar(xml: string, xmpPath: string): string {
  try {
    assertWellFormed(xml);
    return xml;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('duplicate attribute:')) throw error;
    const repair = removeDuplicateAttributes(xml);
    if (!repair) throw error;
    try {
      assertWellFormed(repair.xml);
    } catch {
      throw error;
    }
    if (!warnedDuplicateSidecars.has(xmpPath)) {
      warnedDuplicateSidecars.add(xmpPath);
      log.warn(
        { xmpPath, attributes: repair.removed },
        'sidecar repeats an attribute; developing from the first occurrence',
      );
    }
    return repair.xml;
  }
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
  const source = await readFile(xmpPath, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (source === null || source.length === 0) return null;

  // The native adjustment parser tolerates incomplete XML. Validate the cold
  // read, then pass that exact XML snapshot to the recipe renderer so neither
  // a concurrent save nor a missing film LUT can silently lose edits (#3971, #3976).
  const xml = wellFormedSidecar(source, xmpPath);
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
