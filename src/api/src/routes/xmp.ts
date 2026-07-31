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
 * two distinct sidecars — matching reference-renderer/Lightroom behaviour and giving
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
import * as fs from 'node:fs/promises';
import { xmpSidecarPath, writeXmpAtomic, deleteXmpSidecar } from '../fs/xmp.ts';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
// Note: we deliberately bypass `readXmp` from `../fs/xmp.ts` and call
// `fs.readFile` directly so we can distinguish "no sidecar" (404) from
// "filesystem error" (500). The id-keyed route conflates those by
// returning an empty XMP stub on ENOENT.

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
      // Force the text parser regardless of the client's Content-Type (the
      // same idiom routes/preview.ts uses with `parse: 'arrayBuffer'`). The
      // web client sends `application/xml`, which the previous `type: 'text'`
      // hook did NOT map to the text parser in this Elysia version — `type`
      // is vestigial there; only `parse` selects a parser. Without it the
      // default content-type sniff routed `application/xml` to the
      // urlencoded parser (both share `charCodeAt(12) === 'x'`), the body
      // arrived as a garbage object, and `t.String()` validation 422'd every
      // live editor write (#2406).
      parse: 'text',
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
