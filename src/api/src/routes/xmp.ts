/**
 * Path-keyed XMP sidecar I/O — slice 3 of #193.
 *
 *   GET    /api/xmp?path=<urlencoded absolute path>
 *   POST   /api/xmp?path=<urlencoded absolute path>   (body: full XMP document)
 *   DELETE /api/xmp?path=<urlencoded absolute path>
 *
 * Replaces the asset-id-keyed `/api/assets/:id/xmp` route. The id-keyed
 * route routed XMP through the deduped asset row (one row per
 * `maple_id`), which silently collapsed N filesystem paths' worth of
 * develop settings onto one sidecar — a latent bug under the
 * content-addressed asset model (#234–#242).
 *
 * The new route does no asset-collection lookup. It validates that the
 * caller-supplied path is inside an indexed library root, resolves the
 * `.xmp` sibling on disk, and performs the read / write / delete
 * directly. Two distinct paths that happen to share a `maple_id` get
 * two distinct sidecars — matching ACR/Lightroom behaviour and giving
 * us the shadow-copy primitive for free.
 *
 * Auth boundary: the path must be under one of the registered library
 * roots (see `loadLibraryRoots()` — the same roots that gate the
 * id-keyed route via `safeWriteAllowed`). Path traversal (`..`,
 * absolute paths to `/etc/passwd`, etc.) is rejected because the
 * normalized form is checked against the root set.
 *
 * Symlinks: by design we do NOT resolve symlinks before writing the
 * sidecar — if two paths resolve to the same underlying RAW via a
 * symlink, the sidecars share by virtue of the filesystem
 * (`xmpSidecarPath` operates on the user-supplied path). Two paths
 * with independent .xmp neighbours stay independent — see the design
 * note on #193.
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { xmpSidecarPath, writeXmpAtomic, deleteXmpSidecar } from '../fs/xmp.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
// Note: we deliberately bypass `readXmp` from `../fs/xmp.ts` and call
// `fs.readFile` directly so we can distinguish "no sidecar" (404) from
// "filesystem error" (500). The id-keyed route conflates those by
// returning an empty XMP stub on ENOENT.

/**
 * Resolve and validate a caller-supplied path query parameter.
 *
 *   ok:true  → `data` is the (lexically normalized) absolute path,
 *              guaranteed to be inside a library root.
 *   ok:false → `error` describes why; `status` is the HTTP status to
 *              return (400 for malformed, 403 for outside any root).
 *
 * We deliberately use `path.resolve()` (lexical) rather than
 * `fs.realpath()` so that user symlinks are preserved end-to-end. The
 * library-root containment check is done against the normalized form,
 * which is still sufficient to block `..` traversal.
 */
async function resolveAndAuthorizePath(
  raw: string | undefined,
): Promise<{ ok: true; data: string } | { ok: false; status: number; error: string }> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, status: 400, error: 'Missing required query parameter: path' };
  }
  // Elysia already URL-decodes query strings, but Bun + raw fetch
  // sometimes hand us a still-encoded value if the caller built the URL
  // by hand. Be defensive.
  let decoded = raw;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(raw)) decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, status: 400, error: 'Path is not a valid URL-encoded string' };
  }
  if (!path.isAbsolute(decoded)) {
    return { ok: false, status: 400, error: 'Path must be absolute' };
  }
  // Reject NUL bytes outright — they can short-circuit C-level path
  // handling in surprising ways.
  if (decoded.indexOf('\x00') !== -1) {
    return { ok: false, status: 400, error: 'Path contains NUL byte' };
  }

  const normalized = path.resolve(decoded);

  const envRoots = process.env.MAPLE_ROOTS
    ? process.env.MAPLE_ROOTS.split(':').filter(Boolean)
    : [];
  const libRoots = [...(await loadLibraryRoots()).values()];
  const allRoots = [...envRoots, ...libRoots].map((r) => r.replace(/\/$/, ''));

  if (allRoots.length === 0) {
    // No roots registered. The id-keyed route's `safeWriteAllowed`
    // falls through to "allow all" here as a development convenience,
    // but that's only safe because it still gates on a real asset row.
    // The path-keyed route has no other safety net, so we tighten this
    // to a hard 403 — register a library folder (or set MAPLE_ROOTS)
    // before XMP round-trip will work.
    return {
      ok: false,
      status: 403,
      error: 'No library roots registered; cannot authorise any path',
    };
  }

  for (const root of allRoots) {
    if (normalized === root || normalized.startsWith(root + '/')) {
      return { ok: true, data: normalized };
    }
  }
  return {
    ok: false,
    status: 403,
    error: 'Path is not inside any registered library root',
  };
}

export const xmpPathRoutes = new Elysia()
  // -- Read --------------------------------------------------------------
  .get(
    '/api/xmp',
    async ({ query, set }) => {
      const r = await resolveAndAuthorizePath(query.path);
      if (!r.ok) {
        set.status = r.status;
        return { error: r.error };
      }
      const sidecar = xmpSidecarPath(r.data);
      try {
        const body = await fs.readFile(sidecar, 'utf-8');
        set.headers['Content-Type'] = 'application/xml';
        return body;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'ENOENT'
        ) {
          set.status = 404;
          return { error: 'No XMP sidecar at this path' };
        }
        set.status = 500;
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `XMP read failed: ${msg}` };
      }
    },
    {
      query: t.Object({
        path: t.String({
          description:
            'Absolute filesystem path to the source asset. The sidecar lives at the same path with the extension replaced by `.xmp`.',
        }),
      }),
      detail: {
        summary: 'Read a path-keyed XMP sidecar',
        description:
          'Returns the XMP document at the `.xmp` sibling of the given path, or 404 if no sidecar exists. The path must live inside a registered library root; otherwise 403.',
        tags: ['xmp'],
      },
    },
  )

  // -- Write -------------------------------------------------------------
  .post(
    '/api/xmp',
    async ({ query, body, set }) => {
      const r = await resolveAndAuthorizePath(query.path);
      if (!r.ok) {
        set.status = r.status;
        return { error: r.error };
      }
      const xmlContent =
        typeof body === 'string'
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);
      const outcome = await writeXmpAtomic(r.data, xmlContent);
      if (!outcome.ok) {
        // `writeXmpAtomic` only reports `ok:false` for filesystem-level
        // errors here (we already gated the root check above).
        set.status = 500;
        return { error: outcome.error };
      }
      set.headers['Content-Type'] = 'application/xml';
      return xmlContent;
    },
    {
      type: 'text',
      body: t.String({
        description: 'Full XMP document. No merging — the file is overwritten byte-for-byte.',
      }),
      query: t.Object({
        path: t.String(),
      }),
      detail: {
        summary: 'Write a path-keyed XMP sidecar',
        description:
          'Writes the given XMP document to the `.xmp` sibling of the path. Atomic (writes to `.tmp` then renames). Returns the written document on success.',
        tags: ['xmp'],
      },
    },
  )

  // -- Delete ------------------------------------------------------------
  .delete(
    '/api/xmp',
    async ({ query, set }) => {
      const r = await resolveAndAuthorizePath(query.path);
      if (!r.ok) {
        set.status = r.status;
        return { error: r.error };
      }
      const sidecar = xmpSidecarPath(r.data);
      // Distinguish "didn't exist" (404) from "existed and was deleted"
      // (204). `deleteXmpSidecar` collapses both to ok:true for the
      // id-keyed route, so check existence ourselves.
      let existed = true;
      try {
        await fs.stat(sidecar);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'ENOENT'
        ) {
          existed = false;
        }
      }
      if (!existed) {
        set.status = 404;
        return { error: 'No XMP sidecar at this path' };
      }
      const outcome = await deleteXmpSidecar(r.data);
      if (!outcome.ok) {
        set.status = 500;
        return { error: outcome.error };
      }
      set.status = 204;
      return;
    },
    {
      query: t.Object({
        path: t.String(),
      }),
      detail: {
        summary: 'Delete a path-keyed XMP sidecar',
        description:
          'Removes the `.xmp` sibling of the path. 204 on success, 404 if the sidecar did not exist.',
        tags: ['xmp'],
      },
    },
  );
