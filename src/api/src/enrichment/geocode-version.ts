/**
 * Geocoder handler version — the single source of truth shared by the async
 * geocode worker (`workers/stages/geocode.ts`) and the synchronous ingest-path
 * geocoder (`backup/ingest-geocode.ts`). Both stamp cache rows and read them
 * back with this value, so they MUST agree; living in its own tiny module lets
 * the backup route import the constant without pulling in the whole worker
 * graph.
 *
 * Bump when the `place-parser` output shape changes — `CoordinateCache.get`
 * treats a version mismatch as a miss and forces a re-fetch.
 */
export const GEOCODE_HANDLER_VERSION = 1;
