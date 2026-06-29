/**
 * Batch Metadata API plugin — aggregates the four batch-metadata routes
 * (`POST /api/xmp/batch`, `GET /api/geocode/search`,
 * `POST /api/backup/refile`, `POST /api/metadata/snapshots`) into a single
 * Elysia plugin. Mounted as one `.use()` in the app's authed subtree so it
 * adds a single link to that already-long chain, keeping TS's instantiation
 * depth under control.
 */

import { Elysia } from 'elysia';
import { xmpBatchRoutes } from './xmp-batch.ts';
import { geocodeSearchRoutes } from './geocode-search.ts';
import { backupRefileRoutes } from './backup-refile.ts';
import { metadataSnapshotsRoutes } from './metadata-snapshots.ts';

export const batchMetadataRoutes = new Elysia({ name: 'batchMetadata' })
  .use(xmpBatchRoutes)
  .use(geocodeSearchRoutes)
  .use(backupRefileRoutes)
  .use(metadataSnapshotsRoutes);
