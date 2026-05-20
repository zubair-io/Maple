/**
 * `/api/assets` route entry point.
 *
 * The implementation was split into domain modules under `./assets/`
 * (see #125). This shim preserves the historical import path
 * (`./routes/assets.ts` / `../src/routes/assets.ts`) so existing
 * callers and tests don't need to change.
 *
 *   GET    /api/assets/:id                        — metadata
 *   GET    /api/assets/:id/raw                    — binary RAW bytes
 *   GET    /api/assets/:id/thumb                  — thumbnail
 *   GET    /api/assets/:id/xmp                    — read XMP sidecar
 *   PUT    /api/assets/:id/xmp                    — write XMP sidecar
 *   DELETE /api/assets/:id/xmp                    — delete XMP sidecar
 *   DELETE /api/assets/:id                        — trash / purge
 *   POST   /api/assets/:id/restore                — restore from trash
 *   PUT    /api/assets/:id/place                  — manual place override
 *   PUT    /api/assets/:id/description            — manual caption override
 *   POST   /api/assets/:id/enrichment/requeue     — per-stage requeue
 */

export { assetsRoutes } from "./assets/index.ts";
