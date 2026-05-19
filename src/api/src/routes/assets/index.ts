/**
 * `/api/assets` route composition.
 *
 * Each sub-router is a `new Elysia()` plugin (no prefix) holding one
 * domain's verbs; this file mounts them onto a single parent Elysia
 * instance carrying the shared `/api/assets` prefix.
 *
 * Public surface — `assetsRoutes` — is re-exported from
 * `../assets.ts` so existing callers (and tests) keep importing from
 * the historical path without churn.
 *
 * Route map (full HTTP paths):
 *
 *   GET    /api/assets/:id                        — metadata
 *   GET    /api/assets/:id/raw                    — binary RAW bytes
 *   GET    /api/assets/:id/thumb                  — thumbnail (.maple/ cache)
 *   GET    /api/assets/:id/xmp                    — read XMP sidecar
 *   PUT    /api/assets/:id/xmp                    — write XMP sidecar
 *   DELETE /api/assets/:id/xmp                    — delete XMP sidecar
 *   DELETE /api/assets/:id                        — trash / purge
 *   POST   /api/assets/:id/restore                — restore from trash
 *   PUT    /api/assets/:id/place                  — manual place override
 *   PUT    /api/assets/:id/description            — manual caption override
 *   PUT    /api/assets/:id/ocr                    — manual OCR override
 *   POST   /api/assets/:id/enrichment/requeue     — per-stage requeue
 */

import { Elysia } from "elysia";
import { metadataRoutes } from "./metadata.ts";
import { xmpRoutes } from "./xmp.ts";
import { trashRoutes } from "./trash.ts";
import { overrideRoutes } from "./overrides.ts";
import { enrichmentRoutes } from "./enrichment.ts";

export const assetsRoutes = new Elysia({ prefix: "/api/assets" })
  .use(metadataRoutes)
  .use(xmpRoutes)
  .use(trashRoutes)
  .use(overrideRoutes)
  .use(enrichmentRoutes);
