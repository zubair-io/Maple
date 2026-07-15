/**
 * Path-keyed preview upload — the write half of the KISS preview cache (#2017).
 *
 *   PUT /api/preview?path=<urlencoded absolute path of the ORIGINAL asset>
 *   body = AVIF bytes
 *
 * Publishes an already-rendered AVIF preview to the pure-cache path
 * `<dir>/.maple/previews/<filename>.avif`, next to the original. This is the
 * "save the edited preview just like the XMP sidecar gets saved" path used by
 * remote-editing clients (Apple-cloud #2009, web-server-backed #2010): the
 * editor already holds the developed pixels, so the server just validates and
 * stores them rather than re-rendering from RAW+XMP.
 *
 * Mirrors the path-keyed `/api/xmp` route (`routes/xmp.ts`):
 *   - `resolveAndAuthorizePath` confirms the ORIGINAL asset path is inside a
 *     registered library root (403 otherwise) — the same auth boundary as the
 *     sidecar write; path traversal is rejected by the normalized-root check.
 *   - The body is the raw AVIF bytes.
 *   - Those bytes are validated with a real decode (`validateAvifOutput`,
 *     #2014): a non-AVIF / truncated / mis-sized / mis-tagged body is rejected
 *     422 with the failing reason and never reaches the cache path.
 *   - Publish is atomic — write to a private temp file, then rename into place
 *     (the same write-to-temp-then-rename idiom the stage/thumb encoders use).
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
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('routes/preview');

export const previewPathRoutes = new Elysia().put(
  '/api/preview',
  async ({ query, body, set }) => {
    const r = await resolveAndAuthorizePath(query.path);
    if (!r.ok) {
      set.status = r.status;
      return { error: r.error };
    }

    // Binary body coercion, zero-copy: a Bun-supplied `Uint8Array`/`Buffer` is
    // used as-is (no `Buffer.from` copy of a potentially multi-MB payload), and
    // an `ArrayBuffer` is wrapped in a view over the same memory. Anything else
    // (an empty PUT giving `undefined`, or a mis-typed body) collapses to a
    // zero-length view and is rejected 400 below. `fs.writeFile` accepts a
    // `Uint8Array` directly, so no `Buffer` is needed at all.
    const bytes: Uint8Array =
      body instanceof Uint8Array
        ? body
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(0);
    if (bytes.byteLength === 0) {
      set.status = 400;
      return { error: 'Empty request body; expected AVIF bytes' };
    }

    const previewPath = cachePathFor(r.data, 'previews', PREVIEW_CACHE_SUFFIX);
    const tmpPath = `${previewPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;

    try {
      await fs.mkdir(path.dirname(previewPath), { recursive: true });
      await fs.writeFile(tmpPath, bytes);
    } catch (err) {
      await unlinkQuiet(tmpPath);
      set.status = 500;
      return { error: `Failed to stage preview: ${errMessage(err)}` };
    }

    // Validate the uploaded bytes with a real decode (#2014) BEFORE publishing
    // — a client could upload anything. This calls the #2014 validator directly
    // rather than `publishValidatedAvif` (which validates + renames in one bool)
    // so a bad body can be answered 422 WITH the failing check as the reason (a
    // client-facing HTTP endpoint wants the "why", which the bool helper hides),
    // while a genuine filesystem failure on the rename below stays a 500 — the
    // one decode here is not repeated.
    const validation = await validateAvifOutput(tmpPath, PREVIEW_LONG_EDGE_PX);
    if (!validation.ok) {
      await unlinkQuiet(tmpPath);
      set.status = 422;
      return { error: `Invalid AVIF preview: ${validation.reason}` };
    }

    // Atomic publish: rename the validated temp file into place (POSIX rename
    // is atomic), overwriting any existing preview for this asset.
    try {
      await fs.rename(tmpPath, previewPath);
    } catch (err) {
      await unlinkQuiet(tmpPath);
      set.status = 500;
      return { error: `Failed to publish preview: ${errMessage(err)}` };
    }

    log.debug({ path: r.data, previewPath, bytes: bytes.byteLength }, 'preview uploaded');
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
      summary: 'Upload a rendered AVIF preview for an asset',
      description:
        "Validates the uploaded AVIF via a real decode and atomically publishes it to the asset's single preview cache file. The path must live inside a registered library root; otherwise 403. Returns 204 on success, 422 for an invalid/truncated AVIF, 400 for an empty body.",
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
