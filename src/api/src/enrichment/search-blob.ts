/**
 * Unified `asset.search_blob` synthesis. Concatenates the three text
 * sources that contribute to user-visible search hits (place metadata,
 * LLM caption, OCR'd text), normalises them into a deterministic bag
 * of tokens. `composeSearchBlob` is what every writer uses.
 *
 * Why one field?
 *   One denormalised text field carries all three sources, and one full-text
 *   index covers it. The sources land on different schedules (geocode worker,
 *   describe worker, OCR worker) and each must keep the unified blob coherent
 *   without serialising on a separate write, so the blob is always recomputed
 *   from the live row state rather than read, edited and written back.
 *
 * Tokenisation matches `place-parser.ts:buildSearchBlob`:
 *   - lowercased
 *   - whitespace-split (sequence of any whitespace becomes a delimiter)
 *   - deduped (set semantics)
 *   - alphabetically sorted (so two writers producing the same input
 *     produce a byte-identical blob, regardless of source order)
 */

import type { Place } from '../db/schema.ts';

/**
 * Meteorological (Northern Hemisphere) season for a 1-12 `captured_month` —
 * `null` for an out-of-range or missing month. #2992: a season word should
 * RANK a photo, not filter it, so it rides in `search_blob` (lowest-weight
 * searchable attribute) rather than becoming a date-range query. Deliberately
 * NOT hemisphere-aware — the asset's `place` doesn't reliably carry a
 * latitude this function could use, and the ticket's own worked examples
 * (winter/summer against a Northern-Hemisphere-shot corpus) don't call for
 * it; a hemisphere-flipped season is a real limitation for Southern-
 * Hemisphere libraries, not a silent bug, and can follow later if it proves
 * to matter. */
export function seasonForMonth(month: number | null | undefined): string | null {
  if (month == null || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (month === 12 || month <= 2) return 'winter';
  if (month <= 5) return 'spring';
  if (month <= 8) return 'summer';
  return 'fall';
}

export interface ComposeSearchBlobInput {
  /** Reverse-geocoded place. `null`/`undefined` ⇒ contributes no tokens.
   * Only `search_blob` is read, so a caller that has the blob but not the
   * whole `Place` — the SQLite repo, which reads it straight out of the
   * `place` JSON column — can pass just that field rather than rebuilding a
   * `Place` it does not have. */
  place?: Pick<Place, 'search_blob'> | null;
  /** `exif.captured_month` (1-12), used to derive a season token (#2992).
   * Month NAMES are deliberately never indexed here — `may`/`march`/`august`
   * are ordinary English words, and the date parser already serves an
   * explicit month query; only the season word rides in the blob. */
  capturedMonth?: number | null;
  /** LLM-generated caption from the describe worker (Phase 6). */
  description?: string | null;
  /** OCR-extracted text from the thumbnail (Phase 8). */
  ocrText?: string | null;
  /** Speech-to-text transcript from the asset's audio track. */
  transcript?: string | null;
  /** Structured vision-subjects (e.g. ["person", "child", "athlete"]).
   * Optional — older callers and tests can keep passing nothing. */
  visionSubjects?: string[] | null;
  /** Structured setting (e.g. "sports field", "kitchen"). */
  visionSetting?: string | null;
  /** Structured activity (e.g. "lacrosse", "hiking"). */
  visionActivity?: string | null;
  /** Structured notable objects (e.g. ["lacrosse stick", "cleats"]). */
  visionNotableObjects?: string[] | null;
  /** Flat search keywords from the describe stage (prompt v7). The
   * caption already contributes via `description`, but prose tokenises
   * unevenly — the keyword bag is what makes a term like "sledding"
   * reliably present on every sledding photo. `null` on rows captioned
   * before v7. */
  visionTags?: string[] | null;
  /** Named people appearing in the asset (e.g. ["Greyson", "Maya"]).
   * Resolved from `faces[].person_id` by the caller — the blob can't
   * `$lookup` person names, so the meili stage passes them explicitly.
   * Auto-generated `Person N` clusters are excluded upstream. */
  people?: string[] | null;
  /** Whole-clip summary from the `video-describe` stage (#2158). `null`
   * on a non-video asset, or a video the stage hasn't run on yet. */
  videoSummary?: string | null;
  /** Per-scene captions from `video-describe`, one per sampled frame the
   * model commented on — each contributes once, so a phrase repeated
   * across several similar scenes doesn't inflate the token set. */
  videoSceneCaptions?: string[] | null;
  /** Per-scene visible text from `video-describe`. Distinct from `ocrText`
   * (the poster-frame `describe` stage's OCR): this is text legible in
   * frames sampled later in the clip that the poster never showed. */
  videoSceneTextVisible?: string[] | null;
}

/** Pure: build the unified blob from the contributing sources. Returns `""`
 * when every source is empty so callers can store an unconditional value. */
export function composeSearchBlob(input: ComposeSearchBlobInput): string {
  const tokens = new Set<string>();
  const add = (raw: string | null | undefined): void => {
    if (!raw) return;
    for (const part of raw.toLowerCase().split(/\s+/)) {
      if (part.length > 0) tokens.add(part);
    }
  };

  // The `place.search_blob` is already a normalised bag of tokens, but
  // we still funnel it through `add()` so a future caller that hands us
  // a free-form `place.display_name` instead would get the same shape.
  add(input.place?.search_blob);
  add(input.description);
  add(input.ocrText);
  add(input.transcript);
  add(seasonForMonth(input.capturedMonth));

  // Structured vision signals. Each is a small dictionary contribution
  // that makes facet-like queries hit ("show outdoor sports") without
  // needing a separate facet index. Arrays go through `add()` per
  // element so multi-word strings still tokenise.
  for (const s of input.visionSubjects ?? []) add(s);
  add(input.visionSetting);
  add(input.visionActivity);
  for (const o of input.visionNotableObjects ?? []) add(o);
  for (const t of input.visionTags ?? []) add(t);

  // Named people — each name tokenised so "Greyson Smith" matches either
  // word. The meili stage filters out auto-generated `Person N` names
  // before passing them in.
  for (const p of input.people ?? []) add(p);

  // Video-describe (#2158): the whole-clip summary once, then each unique
  // scene caption and visible-text value once — exactly the design doc's
  // "composeSearchBlob adds the summary once, then each unique scene
  // caption and visible-text value once." `add()`'s own set semantics
  // already dedupe a caption repeated across similar scenes.
  add(input.videoSummary);
  for (const c of input.videoSceneCaptions ?? []) add(c);
  for (const t of input.videoSceneTextVisible ?? []) add(t);

  return [...tokens].sort().join(' ');
}
