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

/** Sort: named clusters first (alphabetical, case/accent-insensitive),
 * then auto-named clusters by descending face count, tiebroken by id so
 * the order is stable across refreshes. */
export function sortPeople(rows: readonly ApiPerson[]): ApiPerson[] {
  return [...rows].sort((a, b) => {
    const aAuto = isAutoNamed(a.name) ? 1 : 0;
    const bAuto = isAutoNamed(b.name) ? 1 : 0;
    if (aAuto !== bAuto) return aAuto - bAuto;
    if (aAuto === 1) {
      if (a.faceCount !== b.faceCount) return b.faceCount - a.faceCount;
      return a.id.localeCompare(b.id);
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
  });
}

/** Operator-named clusters only, used for the rename datalist + the
 * "Merge into…" picker. Expects an already-sorted list. */
export function filterNamed(rows: readonly ApiPerson[]): ApiPerson[] {
  return rows.filter((p) => !isAutoNamed(p.name));
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
export function hiddenFaceCount(
  faces: readonly ApiPersonFace[],
  thresholdPercent: number,
): number {
  return faces.length - visibleFaces(faces, thresholdPercent).length;
}

/** Average detector confidence as percent (0-100, rounded). Returns 0
 * for an empty face list rather than NaN. Labelled honestly in the UI
 * ("avg detector confidence") — the API's `face.confidence` is
 * RetinaFace's face-likelihood score, NOT cluster-match similarity. */
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

/** Toggle a single face key in / out of a selection set. Returns a new
 * `Set` — never mutates the input. Component drives signal updates with
 * the returned set. */
export function toggleSelection(
  selection: ReadonlySet<string>,
  face: { assetId: string; faceIndex: number },
): Set<string> {
  const key = faceKey(face);
  const next = new Set(selection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
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

/** Bbox-crop transform for the face thumb `<img>`. The wrapper is
 * `aspect-square overflow-hidden`; the inner `<img>` is absolute-
 * positioned and we scale + translate so the bbox fills the wrapper.
 * `bbox` is in normalised `[0,1]` proportions of the source image —
 * the face detector emits them this way and they survive end-to-end
 * unchanged. The prototype's `background: center/cover` won't crop to
 * the face; this transform keeps the cover/thumb composed correctly. */
export function faceCropTransform(bbox: Bbox): string {
  const { x, y, w, h } = bbox;
  const scaleX = Math.max(1, 1 / Math.max(0.01, w));
  const scaleY = Math.max(1, 1 / Math.max(0.01, h));
  const scale = Math.max(scaleX, scaleY);
  const tx = -x * 100;
  const ty = -y * 100;
  return `scale(${scale}) translate(${tx}%, ${ty}%)`;
}

// ── Copy / labels ─────────────────────────────────────────────────────────

/** Confirm-prompt body for the per-row + detail-header delete buttons.
 * Pluralises "face"/"faces" honestly so the count chip never reads
 * "1 faces". */
export function deletePersonConfirm(name: string, faceCount: number): string {
  return `Delete "${name}"? Their ${faceCount} face${faceCount === 1 ? '' : 's'} will become unassigned.`;
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

/** Extract a human message from an HttpClient error / Error / unknown
 * thrown value. Handles the common `{ error: { error: "…" } }` shape Bun
 * produces. Identical to the helper in `workers.vm.ts` — duplicated
 * because each slice is scoped to its own folder. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error?: unknown }).error;
    if (inner && typeof inner === 'object' && 'error' in inner) {
      return String((inner as { error: unknown }).error);
    }
    if (typeof inner === 'string') return inner;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
