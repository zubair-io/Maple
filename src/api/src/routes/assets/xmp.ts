/**
 * /api/assets XMP sidecar I/O.
 *
 *   GET    /api/assets/:id/xmp   — read XMP sidecar (or empty stub)
 *   PUT    /api/assets/:id/xmp   — write XMP sidecar (atomic, optional
 *                                  X-If-Mtime-Matches precondition →
 *                                  409 + conflict-copy on mismatch)
 *   DELETE /api/assets/:id/xmp   — delete XMP sidecar (idempotent)
 *
 * `?conflict=<filename>` switches every verb to read/write/delete the
 * named conflict-copy sidecar instead of the canonical one.
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 *
 * Mongo access lives in `src/db/assets.repo.ts`.
 *
 * ## Deprecation (slice 3 of #193)
 *
 * Every response from this route carries the RFC 8594 deprecation
 * signal pointing at the path-keyed successor `/api/xmp?path=…`:
 *
 *   Deprecation: true
 *   Link: </api/xmp?path=...>; rel="successor-version"
 *
 * The web migration (slice 4) flips consumers; the old route gets
 * removed in the follow-up. Do not add new callers.
 */

const DEPRECATION_LINK = '</api/xmp?path=...>; rel="successor-version"';

/** Stamp the deprecation signal onto an Elysia `set.headers` bag. */
function markDeprecated(set: { headers: Record<string, unknown> }): void {
  set.headers['Deprecation'] = 'true';
  // If something upstream already added a Link header, append rather
  // than clobber. RFC 8288 allows comma-separated link values.
  const existing = set.headers['Link'];
  set.headers['Link'] =
    typeof existing === 'string' ? `${existing}, ${DEPRECATION_LINK}` : DEPRECATION_LINK;
}

import { Elysia, t } from 'elysia';
import { readXmp, writeXmpWithPrecondition, deleteXmpSidecar } from '../../fs/xmp.ts';
import {
  readConflictSidecar,
  writeConflictSidecarAtomic,
  deleteConflictSidecar,
} from '../../fs/xmp-conflict.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import {
  findCoreInfoById,
  parseAssetId,
  setHasXmp,
  recordSidecarEdit,
} from '../../db/assets.repo.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';

export const xmpRoutes = new Elysia()
  // Read XMP sidecar
  .get('/:id/xmp', async ({ params, query, set }) => {
    markDeprecated(set);
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const info = await findCoreInfoById(id);
    if (!info) {
      set.status = 404;
      return { error: 'Asset not found' };
    }

    const libs = await loadLibraryRoots();
    const absPath = assetAbsPath(info, libs);
    if (!absPath) {
      set.status = 404;
      return { error: 'Asset has no resolvable location' };
    }

    const conflict = typeof query.conflict === 'string' ? query.conflict : null;
    if (conflict !== null) {
      const result = await readConflictSidecar(absPath, conflict);
      if (!result.ok) {
        set.status = 404;
        return { error: result.error };
      }
      set.headers['Content-Type'] = 'application/xml';
      return result.data;
    }

    const result = await readXmp(absPath);
    if (!result.ok) {
      // No sidecar yet — return empty XMP
      set.headers['Content-Type'] = 'application/xml';
      return emptyXmp(info.filename);
    }

    set.headers['Content-Type'] = 'application/xml';
    return result.data;
  })

  // Write XMP sidecar.
  //
  // Optional headers:
  //   X-If-Mtime-Matches: <epoch-seconds>  Precondition for conflict-copy
  //                                        mode. Omit to write
  //                                        unconditionally.
  //   X-Maple-Device-Name: <string>        Used in the conflict-copy
  //                                        filename. Defaults to
  //                                        "Unknown device".
  //
  // Responses:
  //   204 No Content + Last-Modified header — normal write
  //   409 Conflict   + JSON body { conflict_path, conflict_mtime } —
  //                    precondition mismatch; bytes written to conflict copy
  .put(
    '/:id/xmp',
    // Pre-existing PUT-handler complexity; this PR only swaps the post-write
    // `setHasXmp` for `recordSidecarEdit` (one call, no new branches).
    // fallow-ignore-next-line complexity
    async ({ params, body, headers, query, set }) => {
      markDeprecated(set);
      const id = parseAssetId(params.id);
      if (!id) {
        set.status = 400;
        return { error: 'Invalid asset id' };
      }

      const info = await findCoreInfoById(id);
      if (!info) {
        set.status = 404;
        return { error: 'Asset not found' };
      }

      const libs = await loadLibraryRoots();
      const absPath = assetAbsPath(info, libs);
      if (!absPath) {
        set.status = 404;
        return { error: 'Asset has no resolvable location' };
      }

      const xmlContent =
        typeof body === 'string'
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);

      const conflict = typeof query.conflict === 'string' ? query.conflict : null;
      if (conflict !== null) {
        const outcome = await writeConflictSidecarAtomic(absPath, conflict, xmlContent);
        if (!outcome.ok) {
          set.status = 400;
          return { error: outcome.error };
        }
        set.headers['Last-Modified'] = outcome.mtime.toUTCString();
        set.status = 204;
        // Conflict-sidecar writes still represent a change to the asset's
        // sidecar state — emit so devices subscribing to the change feed
        // pick the new sidecar up.
        await recordAndPublishAssetChange({
          kind: 'update',
          asset_id: id,
          folder_id: info.folder_id,
          abs_path: absPath,
        }).catch(() => {});
        return;
      }

      const ifMtimeHeader = headers['x-if-mtime-matches'];
      const ifMtimeMatchesEpoch =
        typeof ifMtimeHeader === 'string' && /^\d+$/.test(ifMtimeHeader)
          ? parseInt(ifMtimeHeader, 10)
          : null;
      const deviceHeader = headers['x-maple-device-name'];
      const deviceName = typeof deviceHeader === 'string' ? deviceHeader : '';

      const outcome = await writeXmpWithPrecondition(
        absPath,
        xmlContent,
        ifMtimeMatchesEpoch,
        deviceName,
      );

      if (outcome.kind === 'error') {
        set.status = 500;
        return { error: outcome.error };
      }
      if (outcome.kind === 'conflict') {
        set.status = 409;
        return {
          conflict_path: outcome.conflictPath,
          conflict_mtime: outcome.conflictMtime.toISOString(),
        };
      }
      set.headers['Last-Modified'] = outcome.mtime.toUTCString();
      set.status = 204;
      // Mark the asset as carrying an XMP sidecar (working-set `has_xmp`
      // filter, Task B1) and bump the monotonic `sidecar_ver` edit counter.
      await recordSidecarEdit(id).catch(() => {});
      // Best-effort change-feed emit so the File Provider extension can
      // signal the OS to re-fetch this asset's sidecar.
      await recordAndPublishAssetChange({
        kind: 'update',
        asset_id: id,
        folder_id: info.folder_id,
        abs_path: absPath,
      }).catch(() => {});
      return;
    },
    {
      type: 'text',
      body: t.String(),
    },
  )

  // Delete XMP sidecar (idempotent).
  .delete('/:id/xmp', async ({ params, query, set }) => {
    markDeprecated(set);
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }
    const info = await findCoreInfoById(id);
    if (!info) {
      set.status = 404;
      return { error: 'Asset not found' };
    }
    const libs = await loadLibraryRoots();
    const absPath = assetAbsPath(info, libs);
    if (!absPath) {
      set.status = 404;
      return { error: 'Asset has no resolvable location' };
    }
    const conflict = typeof query.conflict === 'string' ? query.conflict : null;
    const result =
      conflict !== null
        ? await deleteConflictSidecar(absPath, conflict)
        : await deleteXmpSidecar(absPath);
    if (!result.ok) {
      set.status = 400;
      return { error: result.error };
    }
    set.status = 204;
    // For canonical-sidecar deletes the asset no longer has an XMP;
    // for conflict-sidecar deletes the canonical may still be there,
    // so leave has_xmp alone in that branch.
    if (conflict === null) {
      await setHasXmp(id, false).catch(() => {});
    }
    // The sidecar state changed — emit a feed event either way.
    await recordAndPublishAssetChange({
      kind: 'update',
      asset_id: id,
      folder_id: info.folder_id,
      abs_path: absPath,
    }).catch(() => {});
    return;
  });

/**
 * Escape a string for safe inclusion inside an XML attribute value.
 *
 * Filenames come from the indexed filesystem and may contain `& < > " '`,
 * any of which would break well-formedness or — for `"` and `<` — allow
 * attribute-breaking / element-injection into the `rdf:about` attribute
 * (see #168). Map all five XML special characters to their entities.
 *
 * XML 1.0 also forbids most C0 control characters (U+0000..U+001F except
 * TAB U+0009, LF U+000A, CR U+000D) in well-formed documents, and a
 * determined attacker with filesystem control could plant such a byte in
 * a filename. Strip them outright — they have no legitimate use in a
 * filename and including them would produce an unparseable XMP sidecar.
 */
export function xmlAttrEscape(s: string): string {
  // Strip XML 1.0-invalid control bytes (U+0000..U+0008, U+000B, U+000C,
  // U+000E..U+001F) before entity-escaping. TAB / LF / CR are preserved.
  // oxlint-disable-next-line no-control-regex -- intentional: strips XML 1.0 invalid control bytes from XMP values
  const stripped = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return stripped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Minimal empty XMP document for an asset that has no sidecar yet. */
export function emptyXmp(filename: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="${xmlAttrEscape(filename)}"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:maple="https://maple.app/xmp/1.0/"
      xmp:Rating="0"
      maple:Flag="0"
      maple:ColorLabel=""
    />
  </rdf:RDF>
</x:xmpmeta>`;
}
