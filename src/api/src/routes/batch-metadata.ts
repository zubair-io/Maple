/**
 * Batch Metadata API plugin (M1) — aggregates the two batch-metadata routes
 * (`POST /api/xmp/batch`, `GET /api/geocode/search`) into a single Elysia
 * plugin. Mounted as one `.use()` in the app's authed subtree so it adds a
 * single link to that already-long chain (keeping TS's instantiation depth
 * under control) rather than two.
 */

import { Elysia } from "elysia";
import { xmpBatchRoutes } from "./xmp-batch.ts";
import { geocodeSearchRoutes } from "./geocode-search.ts";
import { backupRefileRoutes } from "./backup-refile.ts";

export const batchMetadataRoutes = new Elysia({ name: "batchMetadata" })
  .use(xmpBatchRoutes)
  .use(geocodeSearchRoutes)
  .use(backupRefileRoutes);
