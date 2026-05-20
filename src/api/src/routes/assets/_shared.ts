/**
 * Internal helpers shared across the `/api/assets` sub-routers.
 *
 * Kept private to the `routes/assets/` folder — nothing outside the
 * folder should import from here. The public surface is the composed
 * `assetsRoutes` plugin re-exported from `./index.ts` (and the
 * `routes/assets.ts` shim that re-exports it).
 */

import { child as childLogger } from "../../log.ts";

/** Shared logger for every `/api/assets` sub-router. */
export const assetsLog = childLogger("routes:assets");
