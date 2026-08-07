/**
 * Filename-template rendering for the Self Hosted API (#2636) — a thin
 * server-side wrapper over the shared `raw-core` batch-rename engine
 * (`ffi/raw_ffi.ts`'s `renderFilenameTemplate`, backed by
 * `maple_render_filename_template_buf`). Kept separate from
 * `library/batch-rename.ts` so it's independently unit-testable (pure
 * functions, no Mongo, no filesystem) — see
 * docs/superpowers/specs/2026-08-04-file-management-design.md § "Core
 * architecture" → "the ONE piece of that epic that IS shared code."
 */

import * as path from 'node:path';
import { tryGetRawFfi } from '../ffi/raw_ffi.ts';

export interface RenderTemplatedNameInput {
  template: string;
  originalStem: string;
  ext: string;
  /** The asset's `exif.captured_at`, ISO 8601 (or `null`) as stored on
   * `AssetDoc` — converted here to EXIF `DateTimeOriginal`'s
   * `"YYYY:MM:DD HH:MM:SS"` wire format, which is what the engine's
   * `{date:FORMAT}` token expects (`raw_core::filename::date`). An
   * unparseable or missing value renders every `{date:FORMAT}` token as the
   * engine's documented fallback text rather than failing the whole call. */
  capturedAtIso: string | null;
  sequenceStart: number;
  /** Zero-based position of this file within its batch — becomes
   * `{n}`'s value via `sequenceStart + index`. */
  index: number;
  sequencePadWidth: number;
}

export type RenderTemplatedNameResult =
  | { ok: true; name: string }
  | { ok: false; code: number; error: string };

/** Convert `AssetDoc.exif.captured_at` (ISO 8601) to EXIF's
 * `"YYYY:MM:DD HH:MM:SS"` wire format, in UTC — the engine only ever
 * formats the value back out as decimal digits (never does calendar
 * arithmetic on it, see `raw_core::filename::date`'s doc), so a UTC
 * projection of the stored instant is a stable, deterministic choice.
 * Returns `null` for a missing or unparseable input, which the engine
 * treats as "no date" (renders the fallback text, doesn't error). */
export function isoToExifWireFormat(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number, width = 2) => n.toString().padStart(width, '0');
  return (
    `${pad(d.getUTCFullYear(), 4)}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Split a filename into the `{original}` / `{ext}` token inputs the engine
 * expects — `path.parse`'s `.ext` keeps its leading dot, which
 * `RenderInputs::ext` (no leading dot, per `raw-core`'s doc) does not. */
export function splitStemExt(filename: string): { stem: string; ext: string } {
  const parsed = path.parse(filename);
  const ext = parsed.ext.startsWith('.') ? parsed.ext.slice(1) : parsed.ext;
  return { stem: parsed.name, ext };
}

/** Render one filename from a batch-rename template. Returns
 * `{ ok: false, code: -2, ... }` when the native engine isn't loaded
 * (`tryGetRawFfi() === null`) — distinct from the engine's own error codes
 * (which start at `-1`) so a caller can tell "rejected by the rules" apart
 * from "the engine wasn't available to ask." */
export function renderTemplatedName(input: RenderTemplatedNameInput): RenderTemplatedNameResult {
  const ffi = tryGetRawFfi();
  if (!ffi) {
    return {
      ok: false,
      code: -2,
      error: 'filename template engine unavailable (native library not loaded)',
    };
  }
  const result = ffi.renderFilenameTemplate({
    template: input.template,
    originalStem: input.originalStem,
    ext: input.ext,
    capturedAt: isoToExifWireFormat(input.capturedAtIso),
    sequenceStart: input.sequenceStart,
    sequenceIndex: input.index,
    sequencePadWidth: input.sequencePadWidth,
  });
  return result.ok
    ? { ok: true, name: result.name }
    : { ok: false, code: result.code, error: result.error };
}

/** Case-insensitive extension compare — `.JPG` → `.jpg` isn't a real
 * extension change (same format), just a case rewrite. Shared by the
 * single-rename route and batch-rename so both flag extension changes the
 * same way. */
export function extensionChanged(oldName: string, newName: string): boolean {
  return path.extname(oldName).toLowerCase() !== path.extname(newName).toLowerCase();
}
