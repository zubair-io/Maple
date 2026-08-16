/**
 * The bearer-gated API sub-app — every route family that lives behind one
 * shared `requireAuth`. Extracted from index.ts (#2893 review: the entry
 * point crossed the 570-line headroom gate; this block plus its imports was
 * the natural seam).
 *
 * Wrapped in its own named Elysia instance so the `requireAuth`
 * scoped-derive only applies to these routes. Without the sub-app the
 * derive would leak forward to `staticUiPlugin` in index.ts, breaking
 * unauthenticated cold loads (you can't reach /sign-in if the server
 * demands a bearer to serve index.html).
 *
 * Self-gating route families (cloudflare, users, service keys, …) and
 * token-in-query families (events, video) deliberately stay OUT of this
 * sub-app — see the mounting order in index.ts.
 */

import { Elysia } from 'elysia';
import { requireAuth } from '../auth/middleware.ts';
import { foldersRoutes } from './folders.ts';
import { foldersTrashRoutes } from './folders-trash.ts';
import { assetsRoutes } from './assets.ts';
import { xmpPathRoutes } from './xmp.ts';
import { previewPathRoutes } from './preview.ts';
import { fsRoutes } from './fs.ts';
import { fsThumbsRoutes } from './fs-thumbs.ts';
import { fsPreviewsRoutes } from './fs-previews.ts';
import { searchRoutes } from './search.ts';
import { mapRoutes } from './map/index.ts';
import { jobsRoutes } from './jobs.ts';
import { importsRoutes } from './imports.ts';
import { enrichmentRoutes } from './enrichment.ts';
import { observabilityRoutes } from './observability.ts';
import { networkSettingsRoutes } from './network.ts';
import { meilisearchBackfillRoutes } from './admin-backfill-meilisearch.ts';
import { adminMeilisearchStatusRoutes } from './admin-meilisearch-status.ts';
import { purgeSubthresholdFacesRoutes } from './admin-purge-subthreshold-faces.ts';
import { peopleRoutes } from './people.ts';
import { presetsRoutes } from './presets.ts';
import { panoRoutes } from './pano.ts';
import { mapConfigRoutes } from './map-config.ts';
import { batchMetadataRoutes } from './batch-metadata.ts';
import { backupIngestRoutes } from './backup-ingest.ts';
import { backupStateRoutes } from './backup-state.ts';
import { backupExistsRoutes } from './backup-exists.ts';
import { backupSidecarRoutes } from './backup-sidecar.ts';
import { backupRenderedRoutes } from './backup-rendered.ts';
import { backupNotifyDeletedRoutes } from './backup-notify-deleted.ts';
import { changesRoutes } from './changes.ts';
import { mirrorRoutes } from './mirror.ts';
import { derivativeAuditRoutes } from './derivative-audit.ts';
import { assetsListRoutes } from './assets-list.ts';
import { photosRoutes } from './photos.ts';
import { displayRoutes } from './display.ts';
import { renderConfigRoutes } from './render-config.ts';
import { workerRoutes } from '../workers/routes.ts';
import { libraryRoutes } from './library/index.ts';

export const authedApi = new Elysia({ name: 'authedApi' })
  .use(requireAuth)
  // PhotoKit-backup routes — chunked ingest, reconciliation/dedup
  // probes, sidecar + rendered-companion uploads, and deletion
  // reconciliation. Gated behind requireAuth (#853): they accept file
  // writes and destructive deletes, so they must never be reachable
  // without a bearer. The Apple backup clients attach the access token
  // (#855); path containment on the writes is tightened in #854.
  .use(backupIngestRoutes)
  .use(backupStateRoutes)
  .use(backupExistsRoutes)
  .use(backupSidecarRoutes)
  .use(backupRenderedRoutes)
  .use(backupNotifyDeletedRoutes)
  .use(foldersRoutes)
  // Recursive folder trash/restore (#2630) — separate module, same
  // `/api/folders` prefix, kept out of folders.ts to stay under the
  // file-size budget.
  .use(foldersTrashRoutes)
  // M1 unified library addressing routes (slug:relPath).
  // Mounted before assetsRoutes so /api/folder|image|thumb|preview
  // are not shadowed by other prefixes.
  .use(libraryRoutes)
  // Mounted BEFORE assetsRoutes so the bare `GET /api/assets` list
  // endpoint matches before the `:id`-prefixed routes shadow it.
  .use(assetsListRoutes)
  .use(assetsRoutes)
  .use(xmpPathRoutes)
  .use(previewPathRoutes)
  .use(batchMetadataRoutes)
  .use(fsRoutes)
  .use(fsThumbsRoutes)
  .use(fsPreviewsRoutes)
  .use(searchRoutes)
  .use(mapRoutes)
  .use(jobsRoutes)
  .use(importsRoutes)
  .use(enrichmentRoutes)
  .use(observabilityRoutes)
  .use(networkSettingsRoutes)
  .use(meilisearchBackfillRoutes)
  .use(adminMeilisearchStatusRoutes)
  .use(purgeSubthresholdFacesRoutes)
  .use(peopleRoutes)
  .use(presetsRoutes)
  .use(photosRoutes)
  .use(displayRoutes)
  // Render runtime config (#1062) — the web GPU live-render ramp/kill
  // switch. Read by every signed-in client at startup and on a poll.
  .use(renderConfigRoutes)
  .use(panoRoutes)
  .use(mapConfigRoutes)
  .use(changesRoutes)
  .use(mirrorRoutes)
  .use(derivativeAuditRoutes)
  .use(workerRoutes());
