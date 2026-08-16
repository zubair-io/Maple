// People settings — pure view-model module.
//
// Co-located with `people.component.ts` per the `*.vm.ts` pattern adopted
// in #190 (slice 1: info-tab #218, slice 2: workers #291). Anything in
// this file is plain TypeScript: no `@angular/*` imports, no `inject()`,
// no decorators, no signals. The component owns DI, signal wiring, and
// side effects; this module owns the auto-name predicate, sort/filter
// comparators, derivation, face-key plumbing, geometry math, and error
// normalisation.
//
// All `@maple-common` types are imported via `import type` so this
// module compiles/tests as plain TS (lesson from the #218 / #291 PR
// reviews — the barrel may transitively pull Angular).

import type { ApiPerson, ApiPersonDetail, ApiPersonFace, Bbox } from '@maple-common';

// ── Toast ─────────────────────────────────────────────────────────────────

export type Tone = 'success' | 'error';

export interface Toast {
  text: string;
  tone: Tone;
}

/** Auto-toast dismiss delay. Component schedules a `setTimeout` against
 * this — keeping it here so the timing is documented once. */
export const TOAST_TTL_MS = 3_500;

// ── Auto-name predicate ───────────────────────────────────────────────────

/** Strict regex for the server's auto-assigned cluster names. The loose
 * `name.startsWith('Person ')` heuristic would miscategorise operator-
 * named clusters like "Person Alice" as auto-named — keep this anchored. */
export const AUTO_NAME_RE = /^Person \d+$/;

export function isAutoNamed(name: string): boolean {
  return AUTO_NAME_RE.test(name);
}

// ── List-view derivation ──────────────────────────────────────────────────

export interface PeopleStats {
  named: number;
  unnamed: number;
  faces: number;
}

/** Stats line for the list view ("12 named · 138 unnamed · 30,142 faces").
 * "Last clustered" is intentionally omitted — the API doesn't surface a
 * timestamp and we won't fabricate one. */
export function peopleStats(rows: readonly ApiPerson[]): PeopleStats {
  let named = 0;
  let faces = 0;
  for (const p of rows) {
    if (!isAutoNamed(p.name)) named++;
    faces += p.faceCount;
  }
  return { named, unnamed: rows.length - named, faces };
}

/** Sort: named clusters first, then auto-named ones. WITHIN each group,
 * most faces first, so the biggest identities float to the top (named rows
 * used to be alphabetical — face count is the more useful ordering once a
 * library has more than a handful of people). Ties break by name for named
 * rows and by id for auto-named ones, so the order is stable across
 * refreshes either way. */
export function sortPeople(rows: readonly ApiPerson[]): ApiPerson[] {
  return [...rows].sort((a, b) => {
    const aAuto = isAutoNamed(a.name) ? 1 : 0;
    const bAuto = isAutoNamed(b.name) ? 1 : 0;
    if (aAuto !== bAuto) return aAuto - bAuto;
    if (a.faceCount !== b.faceCount) return b.faceCount - a.faceCount;
    return aAuto === 1
      ? a.id.localeCompare(b.id)
      : a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
  });
}

/** Face-count floor for the list's "hide small clusters" toggle. Most
 * libraries accumulate a long tail of tiny clusters (a few stray
 * detections each); hiding them by default keeps the grid readable. */
export const SMALL_CLUSTER_MIN_FACES = 20;

/** Rows with at least `min` faces — backs the list grid's "hide small
 * clusters" toggle. Deliberately NOT applied to the merge-target list or
 * the stats line: a hidden-from-the-grid cluster is still a valid merge
 * destination, and the stats stay a whole-library summary. */
export function filterSmallClusters(rows: readonly ApiPerson[], min: number): ApiPerson[] {
  return rows.filter((p) => p.faceCount >= min);
}

/** Operator-named clusters only, used for the rename datalist + the
 * "Merge into…" picker. Expects an already-sorted list. */
export function filterNamed(rows: readonly ApiPerson[]): ApiPerson[] {
  return rows.filter((p) => !isAutoNamed(p.name));
}

/** Merge-target candidates: named people minus the given ids (the currently-
 * selected people, or the open person on the detail page). Feeds both the list
 * bulk-merge `<select>` and the detail "Merge into…" picker. */
export function mergeTargets(
  named: readonly ApiPerson[],
  excludeIds: ReadonlySet<string>,
): ApiPerson[] {
  return named.filter((p) => !excludeIds.has(p.id));
}

// ── Virtual-scroll row packing ──────────────────────────────────────────────
//
// The list grid renders ~15k uniform cards. To window the DOM with CDK's
// `cdk-virtual-scroll-viewport` (which virtualises a flat item stream by a
// fixed `itemSize`) over a multi-column responsive grid, we pre-pack the
// sorted people into fixed-height rows of `cols` cards each and virtualise the
// ROWS. `cols` is derived from the measured container width (see
// `peopleGridColumns`); the row height (the viewport's `itemSize`) is derived
// from the card width + meta footer (see `peopleRowHeight`). This mirrors the
// asset-grid's row-packing approach.

/** Layout constants for the list-view card grid. Kept here (not the SCSS) so
 * the row-packing math and the viewport `itemSize` agree with the rendered
 * cards. `MIN_CARD_W` matches the SCSS `minmax(180px, 1fr)`; `META_H` is the
 * card footer height (name + stats + padding); `GAP` matches the grid gap. */
export const PEOPLE_GRID = {
  MIN_CARD_W: 180,
  GAP: 12,
  /** Footer block under the square thumb: 10px*2 padding + ~13px name +
   * 4px margin + ~16px stats line ≈ 53px. */
  META_H: 53,
} as const;

/** Column count for a given content width. At least one column; otherwise the
 * largest count whose cards (≥ MIN_CARD_W) plus gaps fit the width — matching
 * CSS `repeat(auto-fill, minmax(MIN_CARD_W, 1fr))`. */
export function peopleGridColumns(
  contentWidth: number,
  minCardW: number = PEOPLE_GRID.MIN_CARD_W,
): number {
  if (contentWidth <= 0) return 1;
  const cols = Math.floor((contentWidth + PEOPLE_GRID.GAP) / (minCardW + PEOPLE_GRID.GAP));
  return Math.max(1, cols);
}

/** Rendered card width (square thumb side) for `cols` columns in
 * `contentWidth`. Cards stretch to fill the row (the `1fr` behaviour). */
export function peopleCardWidth(contentWidth: number, cols: number): number {
  if (cols <= 0 || contentWidth <= 0) return PEOPLE_GRID.MIN_CARD_W;
  return (contentWidth - (cols - 1) * PEOPLE_GRID.GAP) / cols;
}

/** Fixed row height = square thumb (card width) + meta footer + the bottom
 * gap. This is the viewport `itemSize`. */
export function peopleRowHeight(cardWidth: number): number {
  return Math.round(cardWidth + PEOPLE_GRID.META_H + PEOPLE_GRID.GAP);
}

/** Chunk a flat (already sorted) list into rows of `cols` items each. The
 * last row may be short; CSS keeps short rows left-aligned. */
export function chunkPeopleRows(rows: readonly ApiPerson[], cols: number): ApiPerson[][] {
  const n = Math.max(1, cols);
  const out: ApiPerson[][] = [];
  for (let i = 0; i < rows.length; i += n) {
    out.push(rows.slice(i, i + n));
  }
  return out;
}

/** `trackBy` key for a virtualised packed row: the first card's id so row
 * identity survives re-packs of the same head item; falls back to the index
 * for an (empty) row. */
export function peopleRowKey(index: number, row: readonly ApiPerson[]): string {
  return row.length ? row[0].id : `r${index}`;
}

// ── Image natural-dimension cache ────────────────────────────────────────────

/** Source pixel dimensions of a thumb, read from the `<img>` `(load)` event. */
export interface NaturalDims {
  nw: number;
  nh: number;
}

/** Return a `(url → NaturalDims)` map updated with the given dimensions, or the
 * SAME map reference when there's nothing to change (zero/negative dims, or the
 * url already holds these exact dims). Keeping the ref stable lets the caller's
 * signal skip a needless emission. Never mutates the input. */
export function withNaturalDims(
  cur: ReadonlyMap<string, NaturalDims>,
  url: string,
  nw: number,
  nh: number,
): ReadonlyMap<string, NaturalDims> {
  if (nw <= 0 || nh <= 0) return cur;
  const prev = cur.get(url);
  if (prev && prev.nw === nw && prev.nh === nh) return cur;
  return new Map(cur).set(url, { nw, nh });
}

// ── Detail-view derivation ────────────────────────────────────────────────

/** Visible (threshold-filtered + confidence-sorted) faces. Sort is
 * high-confidence-first so the strongest matches anchor the top of the
 * grid. `thresholdPercent` is the 0-100 slider value; faces with
 * `confidence >= thresholdPercent / 100` survive. */
export function visibleFaces(
  faces: readonly ApiPersonFace[],
  thresholdPercent: number,
): ApiPersonFace[] {
  const min = thresholdPercent / 100;
  return faces.filter((f) => f.confidence >= min).sort((a, b) => b.confidence - a.confidence);
}

/** Faces hidden by the threshold slider — surfaced in the count chip
 * so the operator knows the slider is excluding data. */
export function hiddenFaceCount(faces: readonly ApiPersonFace[], thresholdPercent: number): number {
  return faces.length - visibleFaces(faces, thresholdPercent).length;
}

/** Average detector confidence as percent (0-100, rounded). Returns 0
 * for an empty face list rather than NaN. Labelled honestly in the UI
 * ("avg detector confidence") — the API's `face.confidence` is the
 * SCRFD detector's face-likelihood score, NOT cluster-match similarity. */
export function averageConfidence(faces: readonly ApiPersonFace[]): number {
  if (faces.length === 0) return 0;
  const sum = faces.reduce((acc, f) => acc + f.confidence, 0);
  return Math.round((sum / faces.length) * 100);
}

// ── Face-selection plumbing ───────────────────────────────────────────────

/** Composite key used to track per-face selection independent of object
 * identity. Stale keys (from a refresh) are dropped silently by
 * `pickSelectedFaces` below. */
export function faceKey(face: { assetId: string; faceIndex: number }): string {
  return `${face.assetId}:${face.faceIndex}`;
}

/** Build a fresh selection set covering every face in `faces`. Used by
 * the "Select all visible" action. */
export function selectAllKeys(faces: readonly ApiPersonFace[]): Set<string> {
  const next = new Set<string>();
  for (const f of faces) next.add(faceKey(f));
  return next;
}

/** Toggle a single key in / out of a selection set. Returns a NEW `Set` —
 * never mutates the input. The one immutable add/remove primitive behind both
 * face selection (keyed by `faceKey`) and people selection (keyed by id). */
export function toggleKey(selection: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Toggle a single face key in / out of a selection set. Thin wrapper over
 * {@link toggleKey}. */
export function toggleSelection(
  selection: ReadonlySet<string>,
  face: { assetId: string; faceIndex: number },
): Set<string> {
  return toggleKey(selection, faceKey(face));
}

/** Intersect `selection` with the live `detail.faces` list, returning the
 * matching `ApiPersonFace` objects. Stale keys are dropped silently so a
 * mid-flight refresh doesn't crash the bulk-apply fan-out. */
export function pickSelectedFaces(
  detail: ApiPersonDetail | null,
  selection: ReadonlySet<string>,
): ApiPersonFace[] {
  if (!detail) return [];
  return detail.faces.filter((f) => selection.has(faceKey(f)));
}

// ── Geometry ──────────────────────────────────────────────────────────────

/** Bbox-crop transform for the face thumb `<img>`. The wrapper is a
 * 1:1 square with `overflow: hidden`; the inner `<img>` is
 * `position: absolute; left:0; top:0; width/height:100%;
 * object-fit: cover`, so the source thumbnail is centre-cropped along
 * its long axis before we ever touch it. The transform then maps the
 * (padded) detector bbox to the container.
 *
 * `bbox` is in normalised `[0,1]` proportions of the source image —
 * the face detector emits them this way and they survive end-to-end
 * unchanged.
 *
 * Math:
 *   - Pad the bbox 25% on each side so heads, chins and ears aren't
 *     shaved off the edges.
 *   - When `naturalDims` is supplied, convert the source-normalised bbox
 *     into element-space coords (`bx, by, bw, bh`) by accounting for
 *     the `object-fit: cover` letterbox. Without this step a 3:2
 *     landscape thumbnail cropped to a square loses ~25% off each
 *     horizontal side, so the bbox drifts visibly off-centre.
 *   - Scale by `1 / max(bw, bh)` so the longer bbox axis fills the
 *     container, and translate so the bbox centre lands at (0.5, 0.5).
 *
 * Callers should pass `naturalDims` (read from the `<img>` `(load)`
 * event) once available; the aspect-naïve fallback is used on first
 * paint so the thumb isn't visibly worse than the pre-padding version. */
export function faceCropTransform(
  bbox: Bbox,
  naturalDims?: { nw: number; nh: number } | null,
): string {
  const PAD = 0.25;
  const x = Math.max(0, bbox.x - bbox.w * PAD);
  const y = Math.max(0, bbox.y - bbox.h * PAD);
  const w = Math.min(1, bbox.x + bbox.w * (1 + PAD)) - x;
  const h = Math.min(1, bbox.y + bbox.h * (1 + PAD)) - y;

  let bx: number;
  let by: number;
  let bw: number;
  let bh: number;
  if (naturalDims && naturalDims.nw > 0 && naturalDims.nh > 0) {
    const aspect = naturalDims.nw / naturalDims.nh;
    if (aspect >= 1) {
      bx = -(aspect - 1) / 2 + x * aspect;
      by = y;
      bw = w * aspect;
      bh = h;
    } else {
      const ia = 1 / aspect;
      bx = x;
      by = -(ia - 1) / 2 + y * ia;
      bw = w;
      bh = h * ia;
    }
  } else {
    bx = x;
    by = y;
    bw = w;
    bh = h;
  }
  const scale = 1 / Math.max(0.01, Math.max(bw, bh));
  const tx = 0.5 / scale - bx - bw / 2;
  const ty = 0.5 / scale - by - bh / 2;
  return `scale(${scale}) translate(${tx * 100}%, ${ty * 100}%)`;
}

// ── Copy / labels ─────────────────────────────────────────────────────────

/** Confirm-prompt body for a bulk / explicit merge. The target survives; the
 * merged people's faces are reassigned to it. Pluralises honestly. */
export function mergePeopleConfirm(count: number, targetName: string): string {
  const noun = count === 1 ? 'person' : 'people';
  return `Merge ${count} ${noun} into "${targetName}"? Their faces will be reassigned to "${targetName}" and the merged ${noun} will disappear from the list.`;
}

/** Toast text after a clustering run. Reads cleanly for the zero-result
 * case ("No new faces to assign.") and pluralises the count line. */
export function clusteringSummary(result: { assigned: number; newPeople: number }): string {
  if (result.assigned === 0) return 'No new faces to assign.';
  const facesNoun = result.assigned === 1 ? 'face' : 'faces';
  const personNoun = result.newPeople === 1 ? 'person' : 'persons';
  return `Assigned ${result.assigned} ${facesNoun} to ${result.newPeople} new ${personNoun}.`;
}

/** Toast text after a successful bulk operation. `verb` is the
 * past-tense word the call site provides ("Moved", "Unassigned", "Hid"). */
export function bulkSuccessLabel(verb: string, count: number): string {
  return `${verb} ${count} face${count === 1 ? '' : 's'}.`;
}

/** Toast text for the failed-portion of a bulk operation. The first
 * rejection's reason is surfaced — picking one rather than concatenating
 * keeps the toast tight; the rest are implicit in the count. */
export function bulkFailureLabel(count: number, reason: string): string {
  return `${count} face${count === 1 ? '' : 's'} failed: ${reason}`;
}

// ── Error normalisation ───────────────────────────────────────────────────

// Re-exported from the shared util. (The implementation used to be
// duplicated here and in `workers.vm.ts`; both now delegate to the single
// copy in `maple-common/src/lib/util/errors`.)
export { errorMessage } from '@maple-common';
