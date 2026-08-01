/**
 * The `/api/search*` query-string contract: the Elysia validation schema
 * (`SearchQueryT`) and the TypeScript mirror handlers read (`SearchQuery`).
 *
 * Split out of `query.ts` in #2129 — that file holds the *interpretation*
 * of these params (`buildFilter`, `applyLiveFilter`, the coercion helpers),
 * which is a separate concern from their declaration and was pushing it past
 * the file-size budget. `query.ts` re-exports both names, so importers are
 * unaffected.
 *
 * Every field is a string because these arrive as query-string values;
 * numeric/boolean coercion happens in `query.ts`.
 */

import { t } from 'elysia';

export interface SearchQuery {
  q?: string;
  /** Phase 3+: free-text search against the unified `asset.search_blob`
   * text index (place + description + ocr_text). Distinct from `q`
   * (filename substring) so a caller can mix the two —
   * `q=DJI&placeQuery=Albany NY` finds DJI files captured in Albany. */
  placeQuery?: string;
  libraryId?: string;
  camera?: string;
  lens?: string;
  isoMin?: string;
  isoMax?: string;
  apertureMin?: string;
  apertureMax?: string;
  focalMin?: string;
  focalMax?: string;
  from?: string;
  to?: string;
  rating?: string;
  flag?: string;
  color?: string;
  ext?: string;
  pathPrefix?: string;
  hasCapturedAt?: string;
  /** Closed-union from `vision.scene_type` (indoor / outdoor / aerial / …). */
  sceneType?: string;
  /** Open-vocab `vision.activity` exact match. */
  activity?: string;
  /** Comma-separated `vision.subjects` — OR within the field (any match
   * wins), AND against other top-level filters. */
  subjects?: string;
  /** Screenshot filter. `"true"` shows only screenshots, `"false"` shows
   * only photographs, omitted shows everything. */
  isScreenshot?: string;
  /** Comma-separated person names for an explicit person picker. Passed to
   * the Meilisearch `people` filterable attribute; the Mongo `$text`
   * fallback already covers names via `search_blob`. */
  people?: string;
  /** UI scope chip from the responsive-program S7 search surface.
   * `photos` (or absent) is the default and matches the full live set;
   * `places` narrows to assets with EXIF GPS; `people` narrows to assets
   * with at least one detected face; `albums` is a no-op today (returns
   * `{ results: [], notImplemented: true }`) because the schema has no
   * album field — see `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`
   * and `db/schema.ts` `AssetDoc`. */
  scope?: string;
  /** Hidden image filter. "only" returns only hidden images, "all" returns everything,
   * omitted or "none" (default) excludes hidden images. */
  hidden?: string;
  /** `"true"` drops every asset showing a soft-hidden person (a face whose
   * `person_id` is a hidden person). Opt-in — omitted keeps the historical
   * behaviour, where hiding a person only removes them from the People
   * listing and their photos still surface in search. Ambient surfaces that
   * display photos unattended (Maple TV's Light Table) set it so someone the
   * operator deliberately hid can't reappear on a living-room screen. */
  excludeHiddenPeople?: string;
  page?: string;
  limit?: string;
  sort?: string;
  /** Opaque seek cursor from a previous response's `nextCursor` (#2129).
   * When present it replaces `page` entirely — see `cursor.ts`. Only the
   * `captured_desc` / `captured_asc` sorts mint one; sending a cursor on
   * any other sort, or alongside a residual `placeQuery`, is a 400. */
  cursor?: string;
}

export const SearchQueryT = t.Object({
  q: t.Optional(t.String()),
  placeQuery: t.Optional(t.String()),
  libraryId: t.Optional(t.String()),
  camera: t.Optional(t.String()),
  lens: t.Optional(t.String()),
  isoMin: t.Optional(t.String()),
  isoMax: t.Optional(t.String()),
  apertureMin: t.Optional(t.String()),
  apertureMax: t.Optional(t.String()),
  focalMin: t.Optional(t.String()),
  focalMax: t.Optional(t.String()),
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  rating: t.Optional(t.String()),
  flag: t.Optional(t.String()),
  color: t.Optional(t.String()),
  ext: t.Optional(t.String()),
  pathPrefix: t.Optional(t.String()),
  hasCapturedAt: t.Optional(t.String()),
  sceneType: t.Optional(t.String()),
  activity: t.Optional(t.String()),
  subjects: t.Optional(t.String()),
  isScreenshot: t.Optional(t.String()),
  people: t.Optional(t.String()),
  scope: t.Optional(t.String()),
  hidden: t.Optional(t.String()),
  excludeHiddenPeople: t.Optional(t.String()),
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  sort: t.Optional(t.String()),
  cursor: t.Optional(t.String()),
});
