/**
 * Path-keyed preview upload — the write half of the KISS preview cache (#2017).
 *
 *   PUT /api/preview?path=<urlencoded absolute path of the ORIGINAL asset>
 *   body = AVIF bytes, OR JPEG bytes (#2018)
 *
 * Publishes an already-rendered preview to the pure-cache path
 * `<dir>/.maple/previews/<filename>.avif`, next to the original. This is the
 * "save the edited preview just like the XMP sidecar gets saved" path used by
 * remote-editing clients (Apple-cloud #2009, web-server-backed #2018): the
 * editor already holds the developed pixels, so the server just needs to get
 * them onto disk as genuine AVIF.
 *
 * Mirrors the path-keyed `/api/xmp` route (`routes/xmp.ts`):
 *   - `resolveAndAuthorizePath` confirms the ORIGINAL asset path is inside a
 *     registered library root (403 otherwise) — the same auth boundary as the
 *     sidecar write; path traversal is rejected by the normalized-root check.
 *   - Publish is atomic — write to a private temp file, then rename into place
 *     (the same write-to-temp-then-rename idiom the stage/thumb encoders use).
 *
 * Two accepted input formats (#2018, dropped from #2017's original AVIF-only
 * shape once #2010 measured that current browsers' canvas `convertToBlob`
 * cannot genuinely encode AVIF — see `docs/caching.md`'s edit-time-persist
 * section): `sniffPreviewBodyFormat` below distinguishes AVIF from JPEG via
 * Content-Type first, falling back to a magic-byte sniff.
 *   - **AVIF body** (a browser that CAN canvas-encode AVIF, or a non-browser
 *     client like Apple): staged straight to a temp file — unchanged from
 *     #2017.
 *   - **JPEG body** (the common case today — no browser ships canvas AVIF
 *     encode): staged to a temp file and transcoded to AVIF via
 *     `renderImageThumbToFileViaPool`, the SAME isolated-child-process sharp
 *     pipeline `indexer/previewer.ts` uses for bitmap sources — so a
 *     malformed/hostile JPEG can only crash that isolated child, never this
 *     HTTP process (see `thumbs/imgdecode-pool.ts`'s module doc for why the
 *     isolation exists).
 *
 * Both branches converge on the same gate before publish: the resulting AVIF
 * bytes are validated with a real decode (`validateAvifOutput`, #2014) — a
 * truncated / mis-sized / mis-tagged result (from either input format) is
 * rejected 422 with the failing reason and never reaches the cache path.
 *
 * The preview is a pure cache — overwritten in place, never an original, always
 * re-derivable — so there is no mtime precondition / conflict-copy dance
 * (unlike the XMP write) and no backup-mirror replication (raw `fs`, not
 * `fs/mirrored`, is correct here).
 */

import { Elysia, t } from 'elysia';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cachePathFor } from '../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX, PREVIEW_LONG_EDGE_PX } from '../indexer/previewer.ts';
import { validateAvifOutput } from '../thumbs/validate-avif.ts';
import { renderImageThumbToFileViaPool } from '../thumbs/imgdecode-pool.ts';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('routes/preview');

/** AVIF quality for a server-side JPEG→AVIF transcode of an uploaded preview.
 * Matches `previewer.ts`'s own quality for this tier so a client-encoded
 * (JPEG, server-transcoded) preview looks the same as one the index-time
 * preview stage produced directly from a bitmap source. */
const PREVIEW_TRANSCODE_AVIF_QUALITY = 70;

type SniffedPreviewFormat = 'avif' | 'jpeg' | 'unknown';

/** JPEG SOI marker (0xFF 0xD8 0xFF) at the start of the body. */
function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** ISOBMFF `ftyp` box at byte offset 4, major brand `avif`/`avis`. */
function looksLikeAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const isFtypBox =
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  if (!isFtypBox) return false;
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return brand === 'avif' || brand === 'avis';
}

/**
 * Determine whether the uploaded body is AVIF or JPEG. `Content-Type` is
 * trusted first — both known senders (the web editor's `canEncodeAvif`-gated
 * AVIF path and its JPEG fallback) set it correctly. A magic-byte sniff is
 * the fallback for a body whose Content-Type didn't survive transport or was
 * never set. Neither signature matching ⇒ `'unknown'`, rejected 422 before
 * ever reaching sharp or the temp-file staging below.
 */
function sniffPreviewBodyFormat(
  bytes: Uint8Array,
  contentType: string | undefined,
): SniffedPreviewFormat {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpeg';
  if (looksLikeJpeg(bytes)) return 'jpeg';
  if (looksLikeAvif(bytes)) return 'avif';
  return 'unknown';
}

/** Outcome of staging an uploaded body (either format) or publishing the
 * result — shared by `stagePreviewToAvif` and `publishStagedPreview` below so
 * the route handler has one uniform shape to branch on. */
type PreviewStepResult =
  | { ok: true; avifTmpPath: string }
  | { ok: false; status: number; error: string };

/**
 * Get validatable AVIF bytes onto disk at a private temp path next to
 * `previewPath`, from either input format:
 *   - `'avif'`: the body IS the AVIF — staged as-is (unchanged from #2017).
 *   - `'jpeg'`: staged to its own temp path, then transcoded via the isolated
 *     imgdecode child (`renderImageThumbToFileViaPool`) — see this file's
 *     module doc for why that isolation matters for an uploaded body.
 *
 * Does NOT validate or publish the result — `publishStagedPreview` does that
 * once, for whichever branch produced `avifTmpPath`.
 */
async function stagePreviewToAvif(
  format: 'avif' | 'jpeg',
  bytes: Uint8Array,
  previewPath: string,
  tmpSuffix: string,
): Promise<PreviewStepResult> {
  const avifTmpPath = `${previewPath}.tmp.${tmpSuffix}`;

  if (format === 'avif') {
    try {
      await fs.writeFile(avifTmpPath, bytes);
      return { ok: true, avifTmpPath };
    } catch (err) {
      await unlinkQuiet(avifTmpPath);
      return { ok: false, status: 500, error: `Failed to stage preview: ${errMessage(err)}` };
    }
  }

  // format === 'jpeg': the common case today (#2018) — no browser ships
  // canvas AVIF encode, so the web editor posts a high-quality JPEG of the
  // developed render instead.
  const jpegTmpPath = `${previewPath}.src-tmp.${tmpSuffix}.jpg`;
  try {
    await fs.writeFile(jpegTmpPath, bytes);
    const result = await renderImageThumbToFileViaPool(
      jpegTmpPath,
      avifTmpPath,
      PREVIEW_LONG_EDGE_PX,
      PREVIEW_TRANSCODE_AVIF_QUALITY,
      'jpg',
      'avif',
    );
    await unlinkQuiet(jpegTmpPath);
    if (!result.ok) {
      await unlinkQuiet(avifTmpPath);
      return {
        ok: false,
        status: 422,
        error: `Invalid JPEG preview: ${result.error ?? 'transcode failed'}`,
      };
    }
    return { ok: true, avifTmpPath };
  } catch (err) {
    await unlinkQuiet(jpegTmpPath);
    await unlinkQuiet(avifTmpPath);
    return { ok: false, status: 500, error: `Failed to transcode preview: ${errMessage(err)}` };
  }
}

/**
 * Validate the staged AVIF with a real decode (#2014) — a client could
 * upload anything, and a JPEG transcode could in principle still misbehave —
 * then atomically publish it to `previewPath` (rename, POSIX-atomic,
 * overwriting any existing preview). Calls the #2014 validator directly
 * rather than `publishValidatedAvif` (which validates + renames in one bool)
 * so a bad body can be answered 422 WITH the failing check as the reason; a
 * genuine filesystem failure on the rename stays a 500.
 */
async function publishStagedPreview(
  avifTmpPath: string,
  previewPath: string,
): Promise<PreviewStepResult> {
  const validation = await validateAvifOutput(avifTmpPath, PREVIEW_LONG_EDGE_PX);
  if (!validation.ok) {
    await unlinkQuiet(avifTmpPath);
    return { ok: false, status: 422, error: `Invalid AVIF preview: ${validation.reason}` };
  }
  try {
    await fs.rename(avifTmpPath, previewPath);
    return { ok: true, avifTmpPath: previewPath };
  } catch (err) {
    await unlinkQuiet(avifTmpPath);
    return { ok: false, status: 500, error: `Failed to publish preview: ${errMessage(err)}` };
  }
}

/** Binary body coercion, zero-copy: a Bun-supplied `Uint8Array`/`Buffer` is
 * used as-is (no `Buffer.from` copy of a potentially multi-MB payload), and
 * an `ArrayBuffer` is wrapped in a view over the same memory. Anything else
 * (an empty PUT giving `undefined`, or a mis-typed body) collapses to a
 * zero-length view and is rejected 400 by the caller. */
function coercePreviewBody(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(0);
}

export const previewPathRoutes = new Elysia().put(
  '/api/preview',
  async ({ query, body, headers, set }) => {
    const r = await resolveAndAuthorizePath(query.path);
    if (!r.ok) {
      set.status = r.status;
      return { error: r.error };
    }

    const bytes = coercePreviewBody(body);
    if (bytes.byteLength === 0) {
      set.status = 400;
      return { error: 'Empty request body; expected AVIF or JPEG bytes' };
    }

    const format = sniffPreviewBodyFormat(bytes, headers['content-type']);
    if (format === 'unknown') {
      set.status = 422;
      return { error: 'Body is neither AVIF nor JPEG (checked Content-Type and magic bytes)' };
    }

    const previewPath = cachePathFor(r.data, 'previews', PREVIEW_CACHE_SUFFIX);
    try {
      await fs.mkdir(path.dirname(previewPath), { recursive: true });
    } catch (err) {
      set.status = 500;
      return { error: `Failed to prepare preview directory: ${errMessage(err)}` };
    }

    const tmpSuffix = `${process.pid}.${randomBytes(8).toString('hex')}`;
    const staged = await stagePreviewToAvif(format, bytes, previewPath, tmpSuffix);
    if (!staged.ok) {
      set.status = staged.status;
      return { error: staged.error };
    }

    const published = await publishStagedPreview(staged.avifTmpPath, previewPath);
    if (!published.ok) {
      set.status = published.status;
      return { error: published.error };
    }

    log.debug({ path: r.data, previewPath, bytes: bytes.byteLength, format }, 'preview uploaded');
    set.status = 204;
    return;
  },
  {
    // `parse: 'arrayBuffer'` so Elysia hands us the raw body bytes untouched
    // regardless of the client's Content-Type (the same idiom the OTLP proxy
    // and backup-sidecar upload use). Without it, an `image/avif` body isn't
    // matched by any default parser and `body` arrives undefined.
    parse: 'arrayBuffer',
    query: t.Object({
      path: t.String({
        description:
          'Absolute filesystem path to the ORIGINAL asset. The preview is written to `<dir>/.maple/previews/<filename>.avif` next to it.',
      }),
    }),
    detail: {
      summary: 'Upload a rendered preview (AVIF or JPEG) for an asset',
      description:
        "Accepts either genuine AVIF (staged as-is) or JPEG (transcoded to AVIF server-side via the isolated imgdecode child, #2018 — for browsers that can't canvas-encode AVIF). Either way, validates the resulting AVIF via a real decode and atomically publishes it to the asset's single preview cache file. The path must live inside a registered library root; otherwise 403. Returns 204 on success, 422 for an invalid/unrecognized/truncated body, 400 for an empty body.",
      tags: ['preview'],
    },
  },
);

/** Best-effort temp-file cleanup — nothing to recover if it's already gone. */
function unlinkQuiet(p: string): Promise<void> {
  return fs.unlink(p).then(
    () => {},
    () => {},
  );
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
