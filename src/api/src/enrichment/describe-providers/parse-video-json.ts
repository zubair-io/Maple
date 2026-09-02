/**
 * Strict parser for the `video-describe` stage's structured-JSON output
 * (#2158 design doc, "Prompt, schema, and trustworthy timestamps").
 *
 * The model returns `frame_index` — a position in the ordered frames it
 * was sent — never a timestamp. `parseVideoJson` validates every index is
 * an integer, in range, and unique, then maps it to the REAL timestamp the
 * sampler recorded for that frame. A hallucinated or out-of-range index is
 * a parse failure, not a value to coerce: this is the one guard that keeps
 * a fabricated time out of `video_description.scenes[].timestamp_ms`.
 *
 * Same strictness posture as `parse-vision-json.ts`: forgive a markdown
 * fence wrapper, reject everything else. A malformed response dead-letters
 * the row for operator triage rather than silently writing partial/garbage
 * structured data into search.
 */

import type { VideoDescriptionDoc, VideoDescriptionScene } from '../../db/schema.ts';
import { stripFences, truncateBytes } from './parse-vision-json-errors.ts';

export { strippedRawFor } from './parse-vision-json-errors.ts';

export type VideoParseReason =
  | 'empty-response'
  | 'not-json'
  | 'not-object'
  | 'missing-field'
  | 'wrong-type'
  | 'bad-frame-index'
  | 'duplicate-frame-index';

/** Short prefix of the raw response embedded in `error.message` — same
 * budget and rationale as `VisionParseError`'s `MESSAGE_SNIPPET_BYTES`
 * (the stage runtime persists only `err.message` into
 * `stages.video-describe.last_error`, which the dead-letter triage UI
 * shows directly). */
const MAX_ERROR_SNIPPET_BYTES = 240;

export class VideoParseError extends Error {
  readonly reason: VideoParseReason;
  constructor(reason: VideoParseReason, message: string, raw: string) {
    super(
      `video-parse[${reason}]: ${message} | raw: ${truncateBytes(raw, MAX_ERROR_SNIPPET_BYTES)}`,
    );
    this.name = 'VideoParseError';
    this.reason = reason;
  }
}

/** JSON Schema fed to Ollama's `format` parameter — grammar-constrains the
 * model's output shape at decode time, same mechanism `VISION_DOC_JSON_SCHEMA`
 * uses for the still-image describe stage. `frame_index`'s valid RANGE
 * depends on how many frames this request sent, which a static schema can't
 * express — `parseVideoJson` enforces that bound itself. */
export const VIDEO_DESCRIPTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1 },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          frame_index: { type: 'integer', minimum: 0 },
          caption: { type: 'string', minLength: 1 },
          text_visible: { type: ['string', 'null'] },
        },
        required: ['frame_index', 'caption', 'text_visible'],
      },
    },
  },
  required: ['summary', 'scenes'],
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a model response into a typed `VideoDescriptionDoc`, mapping each
 * scene's `frame_index` to the millisecond timestamp of the corresponding
 * entry in `timestampsSec` (ordered exactly as the frames were sent to the
 * model). Throws `VideoParseError` on any deviation from the schema,
 * including an index that is not a unique integer in
 * `[0, timestampsSec.length)`.
 */
// fallow-ignore-next-line complexity
export function parseVideoJson(raw: string, timestampsSec: readonly number[]): VideoDescriptionDoc {
  if (raw.length === 0) {
    throw new VideoParseError('empty-response', 'raw response was empty', raw);
  }
  const stripped = stripFences(raw.trim()).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new VideoParseError('not-json', err instanceof Error ? err.message : String(err), raw);
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new VideoParseError('not-object', 'expected a JSON object', raw);
  }
  if (typeof root.summary !== 'string' || root.summary.trim().length === 0) {
    throw new VideoParseError('missing-field', 'summary must be a non-empty string', raw);
  }
  if (!Array.isArray(root.scenes)) {
    throw new VideoParseError('wrong-type', 'scenes must be an array', raw);
  }

  const seenIndexes = new Set<number>();
  // One validation branch per schema field (object shape, frame_index
  // range, uniqueness, caption, text_visible) — splitting further would
  // just move the same checks into more functions.
  // fallow-ignore-next-line complexity
  const scenes: VideoDescriptionScene[] = root.scenes.map((entry, i) => {
    const scene = asRecord(entry);
    if (!scene) {
      throw new VideoParseError('wrong-type', `scenes[${i}] must be an object`, raw);
    }
    const frameIndex = scene.frame_index;
    if (
      typeof frameIndex !== 'number' ||
      !Number.isInteger(frameIndex) ||
      frameIndex < 0 ||
      frameIndex >= timestampsSec.length
    ) {
      throw new VideoParseError(
        'bad-frame-index',
        `scenes[${i}].frame_index must be an integer in [0, ${timestampsSec.length})`,
        raw,
      );
    }
    if (seenIndexes.has(frameIndex)) {
      throw new VideoParseError('duplicate-frame-index', `frame_index ${frameIndex} repeated`, raw);
    }
    seenIndexes.add(frameIndex);

    if (typeof scene.caption !== 'string' || scene.caption.trim().length === 0) {
      throw new VideoParseError(
        'missing-field',
        `scenes[${i}].caption must be a non-empty string`,
        raw,
      );
    }
    const textVisible = scene.text_visible;
    if (textVisible !== null && typeof textVisible !== 'string') {
      throw new VideoParseError(
        'wrong-type',
        `scenes[${i}].text_visible must be a string or null`,
        raw,
      );
    }

    return {
      timestamp_ms: Math.round(timestampsSec[frameIndex]! * 1000),
      caption: scene.caption,
      text_visible: textVisible,
    };
  });

  scenes.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return { summary: root.summary, scenes };
}
