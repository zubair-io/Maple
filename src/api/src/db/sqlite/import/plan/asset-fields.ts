/**
 * The two asset field lists the mapper and the verifier must agree on.
 *
 * They live apart from both so neither imports the other: the mapper decides
 * whether to emit a row from these lists, and the verifier asks MongoDB how
 * many rows to expect from the same lists. Keeping one copy is what makes the
 * count check a real check rather than two independent guesses that happen to
 * match today.
 */

/**
 * An `asset_detail` row exists when the asset carries any of these fields with
 * a non-null value. Every entry is expressible to MongoDB as
 * `{ field: { $ne: null } }`, which is what the expected-count query uses.
 */
export const DETAIL_SOURCE_FIELDS = [
  'description',
  'ocr_text',
  'ocr_meta',
  'vision',
  'vision_meta',
  'transcript',
  'video_description',
  'video_description_meta',
  'metadata_override',
  'derivative_audit',
  'geo_inferred',
] as const;

/** The three names `enrichment_state` accepts — its CHECK constraint's list. */
export const ENRICHMENT_STAGES = ['geocode', 'face', 'describe'] as const;
