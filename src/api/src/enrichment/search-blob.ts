/**
 * Unified `asset.search_blob` synthesis. Concatenates the three text
 * sources that contribute to user-visible search hits (place metadata,
 * LLM caption, OCR'd text), normalises them into a deterministic bag
 * of tokens, and exports the Mongo aggregation-pipeline expression that
 * recomputes the field atomically inside each worker's `complete()`.
 *
 * Why one field?
 *   Mongo allows ONE text index per collection. The three sources land
 *   on different schedules (geocode worker, describe worker, OCR worker)
 *   and each must keep the unified blob coherent without serialising on
 *   a separate write. The aggregation-pipeline `$set` form lets us
 *   recompute the union from the live row state in a single
 *   `updateOne` — no read-modify-write race.
 *
 * Tokenisation matches `place-parser.ts:buildSearchBlob`:
 *   - lowercased
 *   - whitespace-split (sequence of any whitespace becomes a delimiter)
 *   - deduped (set semantics)
 *   - alphabetically sorted (so two writers producing the same input
 *     produce a byte-identical blob, regardless of source order)
 */

import type { Place } from '../db/schema.ts';

export interface ComposeSearchBlobInput {
  /** Reverse-geocoded place. `null`/`undefined` ⇒ contributes no tokens. */
  place?: Place | null;
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
  /** Named people appearing in the asset (e.g. ["Greyson", "Maya"]).
   * Resolved from `faces[].person_id` by the caller — the blob can't
   * `$lookup` person names, so the meili stage passes them explicitly.
   * Auto-generated `Person N` clusters are excluded upstream. */
  people?: string[] | null;
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

  // Structured vision signals. Each is a small dictionary contribution
  // that makes facet-like queries hit ("show outdoor sports") without
  // needing a separate facet index. Arrays go through `add()` per
  // element so multi-word strings still tokenise.
  for (const s of input.visionSubjects ?? []) add(s);
  add(input.visionSetting);
  add(input.visionActivity);
  for (const o of input.visionNotableObjects ?? []) add(o);

  // Named people — each name tokenised so "Greyson Smith" matches either
  // word. The meili stage filters out auto-generated `Person N` names
  // before passing them in.
  for (const p of input.people ?? []) add(p);

  return [...tokens].sort().join(' ');
}

/**
 * Mongo aggregation-pipeline `$set` clause that recomputes
 * `asset.search_blob` from the live row state. Designed to be merged
 * into a worker's existing pipeline `updateOne(..., [{ $set: {...} }])`
 * so the new field lands in the same atomic write as the worker's own
 * outputs.
 *
 * The `overrides` object lets a worker substitute the field IT just
 * computed (e.g. the geocode worker passes a freshly-built `Place`)
 * before the row's currently-stored value, which may be stale at the
 * point the pipeline runs. Each override key maps to the path inside
 * the asset doc; `null`/`undefined` means "use the doc's current value".
 *
 * Tokenisation logic mirrors `composeSearchBlob` exactly — `$reduce`
 * with `$concatArrays` over the three sources, lowercase + split on
 * whitespace, dedup via `$setUnion`, sort via `$sortArray`, join with
 * a single space using a `$reduce` over the sorted set.
 */
export interface SearchBlobOverrides {
  /** Override for the row's `place.search_blob`. Pass a freshly-computed
   * value when this worker IS the geocode worker. */
  placeSearchBlob?: string | null;
  /** Override for the row's `description`. */
  description?: string | null;
  /** Override for the row's `ocr_text`. */
  ocrText?: string | null;
  /** Named people to fold into the blob. The aggregation form can't
   * `$lookup` person names, so callers resolve and pass them explicitly;
   * the supplied tokens are unioned into the computed token set. */
  people?: string[] | null;
}

/** Aggregation pipeline expression that resolves to the synthesised blob.
 * Embed in a `$set` to write to `search_blob`; the surrounding worker
 * supplies the `updateOne(filter, [{ $set: { ... } }])` plumbing. */
export function searchBlobUpdateExpression(
  overrides: SearchBlobOverrides = {},
): Record<string, unknown> {
  // Each source resolves to a candidate string: the explicit override
  // when supplied (including `null`, which means "no contribution"), or
  // the current field value as a fallback. `$ifNull` collapses missing
  // fields to empty strings so the tokeniser doesn't trip on null.
  const placeExpr =
    'placeSearchBlob' in overrides
      ? { $ifNull: [overrides.placeSearchBlob ?? '', ''] }
      : { $ifNull: ['$place.search_blob', ''] };
  const descExpr =
    'description' in overrides
      ? { $ifNull: [overrides.description ?? '', ''] }
      : { $ifNull: ['$description', ''] };
  const ocrExpr =
    'ocrText' in overrides
      ? { $ifNull: [overrides.ocrText ?? '', ''] }
      : { $ifNull: ['$ocr_text', ''] };

  // Tokenise each source: lowercase, normalise whitespace (any
  // tab/newline/CR collapses to a single space — `$split` only splits
  // on the literal delimiter so we have to pre-process), split, drop
  // empties.
  const tokenise = (sourceExpr: unknown): unknown => ({
    $filter: {
      input: {
        $split: [
          {
            // Replace each whitespace flavour with a space, then split.
            // `$replaceAll` is cheap and supported on every Mongo we
            // target. Order matters only for CRLF: replacing CR before
            // LF would create double-spaces, so we do CRLF first then
            // any remaining LFs/tabs.
            $replaceAll: {
              input: {
                $replaceAll: {
                  input: {
                    $replaceAll: {
                      input: {
                        $replaceAll: {
                          input: { $toLower: sourceExpr },
                          find: '\r\n',
                          replacement: ' ',
                        },
                      },
                      find: '\n',
                      replacement: ' ',
                    },
                  },
                  find: '\r',
                  replacement: ' ',
                },
              },
              find: '\t',
              replacement: ' ',
            },
          },
          ' ',
        ],
      },
      cond: { $gt: [{ $strLenCP: '$$this' }, 0] },
    },
  });

  // People tokens are supplied by the caller (no `$lookup` in this
  // expression). Tokenise each name client-side — lowercase + whitespace
  // split — so the union matches the runtime `composeSearchBlob` shape,
  // then fold the literal array into the union.
  const peopleTokens: string[] = [];
  for (const name of overrides.people ?? []) {
    if (!name) continue;
    for (const part of name.toLowerCase().split(/\s+/)) {
      if (part.length > 0) peopleTokens.push(part);
    }
  }

  const allTokens = {
    $setUnion: [tokenise(placeExpr), tokenise(descExpr), tokenise(ocrExpr), peopleTokens],
  };

  // Sort + join with single space. `$reduce` with the empty-string sentinel
  // keeps "no leading space" without an extra `$cond` per element.
  return {
    $reduce: {
      input: { $sortArray: { input: allTokens, sortBy: 1 } },
      initialValue: '',
      in: {
        $cond: [{ $eq: ['$$value', ''] }, '$$this', { $concat: ['$$value', ' ', '$$this'] }],
      },
    },
  };
}
