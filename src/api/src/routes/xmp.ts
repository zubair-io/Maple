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

import { Elysia, status, t } from 'elysia';
import { callNative } from 'maple';
import { parseSidecarWorkflow, PRIMARY_VARIANT_ID } from '../generated/workflow.generated.ts';
import { mergeMetadataIntoXmp } from '../xmp/metadata-serializer.ts';
import * as fs from 'node:fs/promises';
import { xmpSidecarPath, writeXmpAtomic, deleteXmpSidecar } from '../fs/xmp.ts';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { publishSidecarChange } from './xmp-change';
import { serializeSidecarWrite } from '../fs/sidecar-write-order';
import { safeWriteAllowed } from '../fs/root';
import { writeSidecarAtomic } from '../fs/sidecar-io';
import { xmpVariantRoutes } from './xmp-variants';
import { isMissingSidecar } from '../fs/sidecar-io';
import { writeXmpIfUnchanged } from '../fs/xmp-conditional';
import { computeBodyETag } from '../runtime/http-etag';

// Note: we deliberately bypass `readXmp` from `../fs/xmp.ts` and call
// `fs.readFile` directly so we can distinguish "no sidecar" (404) from
// "filesystem error" (500). The id-keyed route conflates those by
// returning an empty XMP stub on ENOENT.

export const xmpPathRoutes = new Elysia()
  .use(xmpVariantRoutes)
  // All four operations use the same authorized, normalized path (#4036).
  .resolve(async ({ query }) => {
    const authorized = await resolveAndAuthorizePath(query.path);
    if (!authorized.ok) return status(authorized.status, { error: authorized.error });
    return { rawPath: authorized.data, sidecar: xmpSidecarPath(authorized.data) };
  })
  // Workflow authoring records share the authorized primary sidecar path.
  .patch(
    '/api/xmp/workflow',
    async ({ rawPath, sidecar, body, set }) => {
      try {
        // Wire validation reports 422; filesystem publication reports 500.
        // Select each boundary's status before invoking the operation that can throw.
        set.status = 422;
        const workflow = parseSidecarWorkflow(body);
        set.status = 500;
        if (workflow.variantId !== PRIMARY_VARIANT_ID)
          return status(422, { error: 'Variant identity does not match the primary sidecar.' });
        const allowed = await safeWriteAllowed(sidecar);
        if (!allowed.ok) return status(403, { error: allowed.error ?? 'Sidecar path not allowed' });
        const destination = allowed.data ?? sidecar;
        return await serializeSidecarWrite(destination, async () => {
          const existing = await fs.readFile(destination, 'utf8').catch((error: unknown) => {
            if (isMissingSidecar(error)) return mergeMetadataIntoXmp('', {});
            throw error;
          });
          const conversion = await callNative('workflowEmbedXmp', [
            JSON.stringify(workflow),
            existing,
          ]);
          if (!conversion.ok) {
            set.status = 422;
            return { error: conversion.error };
          }
          const outcome = await writeSidecarAtomic(
            destination,
            conversion.value,
            'Workflow write failed',
          );
          if (!outcome.ok) {
            set.status = 500;
            return { error: outcome.error };
          }
          await publishSidecarChange(rawPath, true);
          set.headers['Content-Type'] = 'application/xml';
          set.status = 200;
          return conversion.value;
        });
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    {
      query: t.Object({ path: t.String() }),
      body: t.Any(),
      detail: { summary: 'Commit shared workflow metadata to a primary sidecar', tags: ['xmp'] },
    },
  )
  // -- Read --------------------------------------------------------------
  .get(
    '/api/xmp',
    async ({ sidecar, set }) => {
      set.headers['X-Maple-Xmp-Preconditions'] = 'content-etag-v1';
      try {
        const body = await fs.readFile(sidecar, 'utf-8');
        set.headers['Content-Type'] = 'application/xml';
        set.headers['ETag'] = computeBodyETag(body);
        return body;
      } catch (err: unknown) {
        if (isMissingSidecar(err)) {
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
    async ({ rawPath, body, set, request }) => {
      const xmlContent =
        typeof body === 'string'
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);
      const match = request.headers.get('If-Match');
      const absent = request.headers.get('If-None-Match');
      if (
        (match !== null && absent !== null) ||
        (match !== null && !/^"[0-9a-f]{40}"$/.test(match)) ||
        (absent !== null && absent !== '*')
      ) {
        return status(400, { error: 'Use one strong If-Match ETag or If-None-Match: *.' });
      }
      if (match !== null || absent !== null) {
        const conditional = await writeXmpIfUnchanged(rawPath, xmlContent, match);
        if (conditional.kind === 'conflict')
          return status(412, { error: 'XMP changed; reload before saving.' });
        if (conditional.kind === 'error') return status(500, { error: conditional.error });
        await publishSidecarChange(rawPath, true);
        set.headers['Content-Type'] = 'application/xml';
        set.headers['ETag'] = computeBodyETag(conditional.data);
        set.headers['X-Maple-Xmp-Preconditions'] = 'content-etag-v1';
        return conditional.data;
      }
      const outcome = await writeXmpAtomic(rawPath, xmlContent);
      if (!outcome.ok) {
        // Includes failed durable writes and unsupported workflow metadata;
        // either failure leaves the existing sidecar untouched.
        set.status = 500;
        return { error: outcome.error };
      }
      await publishSidecarChange(rawPath, true);
      set.headers['Content-Type'] = 'application/xml';
      return outcome.data;
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
        description:
          'Complete adjustment/metadata XML; retains current Workflow authoring records. Use confirmed variant operations to change history or snapshots.',
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
    async ({ rawPath, sidecar, set }) => {
      // Distinguish "didn't exist" (404) from "existed and was deleted"
      // (204). `deleteXmpSidecar` collapses both to ok:true for the
      // id-keyed route, so check existence ourselves.
      let existed = true;
      try {
        await fs.stat(sidecar);
      } catch (err: unknown) {
        if (isMissingSidecar(err)) {
          existed = false;
        }
      }
      if (!existed) {
        set.status = 404;
        return { error: 'No XMP sidecar at this path' };
      }
      const outcome = await deleteXmpSidecar(rawPath);
      if (!outcome.ok) {
        set.status = 500;
        return { error: outcome.error };
      }
      await publishSidecarChange(rawPath, false);
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
