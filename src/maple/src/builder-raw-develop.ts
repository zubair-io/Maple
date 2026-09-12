/**
 * Free functions for the private RAW-develop-only terminal path behind
 * `MapleImageBuilder.toBuffer`/`toFile` — a recipe- or XMP-driven
 * development of an actual RAW file, as opposed to the bitmap recipe
 * pipeline in `builder-exec.ts`. Split out of `builder.ts` to make room for
 * Tier 2's geometry methods (#3501), colour ops (#3503) and the five filter
 * op methods `builder-filter.ts` adds (#3504 task E5) inside the file-size
 * budget — mirrors the existing `builder-state.ts`/`builder-exec.ts` split.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRawPath, lastResizeWidth, type BuilderState } from './builder-state';
import { assertRawDevelopOutput } from './builder-validate';
import { exportImage, exportRecipe } from './export';
import type { ExportResult } from './types';

/**
 * True when `state` describes a RAW develop rather than a bitmap transform:
 * a recipe, an XMP sidecar, or a RAW file path as input.
 */
export function isRawDevelop(state: BuilderState): boolean {
  return (
    state.inputPath !== null &&
    (state.exportRecipe !== null ||
      state.xmpPath !== null ||
      state.xmpXml !== null ||
      isRawPath(state.inputPath))
  );
}

/**
 * Saved-recipe or XMP-driven RAW development, rendered to a tmp file and
 * read back. `toFile` is the builder's own public terminal, passed in
 * rather than imported (which would make this file import back from
 * `builder.ts`, a cycle) — it re-runs `isRawDevelop` itself and branches
 * accordingly, same as any other caller of `toFile`.
 */
export async function rawDevelopToBuffer(
  state: BuilderState,
  toFile: (outputPath: string) => Promise<ExportResult>,
): Promise<Buffer> {
  const ext = state.format ? `.${state.format === 'jpeg' ? 'jpg' : state.format}` : '.jpg';
  const tmpFile = path.join(
    os.tmpdir(),
    `maple_buf_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
  );
  try {
    const fileRes = await toFile(tmpFile);
    if (!fileRes.ok) {
      throw new Error(fileRes.error || 'Failed to develop RAW to buffer');
    }
    return await fs.readFile(tmpFile);
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {}
  }
}

/**
 * The ops a RAW develop genuinely carries out, as `state` metadata rather
 * than as recipe ops.
 *
 * `resize` is read back as a long-edge limit through `lastResizeWidth`.
 * `toColourspace` is honoured because `pushToColourspace` also writes
 * `state.colorSpace`, which `exportImage` passes to the develop pipeline
 * (#3503 review, cross-task consistency) — a `toColourspace('srgb')` or
 * `('display-p3')` on a RAW therefore exports in that space, exactly as
 * Tier 1's `colorSpace()` does. `toColourspace('b-w')` is NOT in this set:
 * it pushes a `greyscale` op instead of a `toColourspace` one, and the
 * develop pipeline has no greyscale stage, so it is correctly rejected
 * below.
 */
const RAW_DEVELOP_OPS = new Set(['resize', 'toColourspace']);

/**
 * `null` when no metadata method was ever called; otherwise the error
 * message for [`rawDevelopToFile`]/[`rawDevelopToBuffer`] to return/throw
 * (#3507 fix-round-1, item 1) — the RAW-develop path (recipe/XMP export,
 * `export.ts`) doesn't read `state.metadata` at all yet, so
 * `maple(dng).withExif(...).jpeg()`/`.withMetadata({orientation:6})` would
 * otherwise silently produce output without them. Named after whichever
 * method(s) were actually called, in call order.
 */
function unsupportedMetadataForRawDevelop(state: BuilderState): string | null {
  if (state.metadataCallsUsed.length === 0) {
    return null;
  }
  return `${state.metadataCallsUsed.join('/')} is not supported when developing a RAW file yet — see #3507`;
}

/**
 * The first op a RAW develop cannot carry out, as a message — or `null`.
 *
 * The RAW-develop terminal runs the develop pipeline (`exportImage` /
 * `exportRecipe`), not the bitmap recipe executor, so the only ops it can
 * honour are the [`RAW_DEVELOP_OPS`] it reads back off `state` as metadata.
 * Everything else — `blur`, `sharpen`, `median`, `threshold`, `convolve`,
 * `flatten`, `composite`, the geometry ops and the rest of the colour ops —
 * used to be discarded in silence, so `maple('photo.dng').blur(5).toFile(out)`
 * wrote an unblurred file and reported success (#3504 PR-E final review,
 * finding 12).
 *
 * It is returned rather than thrown because `toFile` reports every other
 * failure the same way, as `{ ok: false, error }` — [`rawDevelopToFile`]
 * catches its own `exportImage`/`exportRecipe` rejections for exactly that
 * reason. `toBuffer` still throws, since it turns a failed `toFile` into an
 * exception itself.
 */
function unsupportedOpError(state: BuilderState): string | null {
  const unsupported = state.ops.find((op) => !RAW_DEVELOP_OPS.has(op.op));
  return unsupported === undefined
    ? null
    : `${unsupported.op} is not supported on a RAW develop input yet — see #3504/#3495. ` +
        'Develop the RAW to a bitmap first (toBuffer/toFile), then apply it to that.';
}

/**
 * Saved-recipe or XMP-driven RAW development, written straight to
 * `outputPath`. Wrapped in its own try/catch — unlike `exportImage`'s
 * bitmap-path counterpart in `builder.ts`, this runs before that function's
 * try/catch even starts, so without one of its own a rejection (an FFI
 * throw, or `fs.mkdir` failing on a read-only or nonexistent parent) would
 * reject `toFile`'s promise instead of resolving it to `{ ok: false, error
 * }` like every other `toFile` failure.
 *
 * `assertRawDevelopOutput` runs here rather than inside `.jpeg()`/`.tiff()`/…
 * — `.xmp()`/`.recipe()` can turn a builder into a RAW develop after those
 * per-format methods have already run, so this terminal is the first point
 * that knows a per-format option (`progressive`, `chromaSubsampling`, …)
 * would otherwise be silently dropped by `exportImage`/`exportRecipe`, which
 * carry no such options at all (#3579). Its throw is caught by the try/catch
 * below like any other rejection from this function.
 */
export async function rawDevelopToFile(
  state: BuilderState,
  outputPath: string,
): Promise<ExportResult> {
  const unsupported = unsupportedOpError(state) ?? unsupportedMetadataForRawDevelop(state);
  if (unsupported) {
    return { ok: false, outPath: outputPath, error: unsupported };
  }
  const rawPath = state.inputPath as string;
  try {
    assertRawDevelopOutput(state);
    return state.exportRecipe
      ? await exportRecipe({
          rawPath,
          xmpXml: state.xmpXml ?? undefined,
          recipe: state.exportRecipe,
          filmPath: state.filmPath,
          outPath: outputPath,
        })
      : await exportImage({
          rawPath,
          xmpPath: state.xmpPath,
          format: state.format ?? undefined,
          quality: state.quality,
          colorSpace: state.colorSpace,
          maxLongEdge: state.maxLongEdge || lastResizeWidth(state),
          outPath: outputPath,
        });
  } catch (error) {
    return {
      ok: false,
      outPath: outputPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
