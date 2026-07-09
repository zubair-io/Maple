/**
 * Strict parser for the qwen3-vl describe stage's structured-JSON
 * output. Used by `workers/stages/describe.ts` to convert the raw model
 * response into a typed `VisionDoc` (see `db/schema.ts`).
 *
 * Why strict: qwen sometimes wraps JSON in markdown fences, sometimes
 * adds preamble ("Sure, here is the JSON:"), and occasionally drops a
 * required field. We forgive the fence wrapper (always present in some
 * Ollama builds) but reject everything else — silently coercing a missing
 * key would poison the search index and the dead-letter triage UI is the
 * right surface for "the model produced garbage on this asset."
 *
 * v5 classifies `is_screenshot` first (see `VISION_DOC_JSON_SCHEMA` in
 * `parse-vision-json-enums.ts` for why property order matters) and, when
 * true, every scene-descriptive field (`scene_type`, `setting`, `activity`,
 * `time_of_day`, `lighting`, `weather`, `composition`, `shot_type`) is
 * forced to `null` regardless of what the model emitted for those fields —
 * the screenshot short-circuit is enforced here, not merely requested in
 * the prompt.
 *
 * Throws `VisionParseError` (a typed subclass of `Error`) with a truncated
 * snippet of the raw response in its message. The runtime then stamps
 * the message into `stages.describe.last_error` automatically.
 *
 * Spec: `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`
 * §Failure modes.
 *
 * Helpers live in sibling files (split for the file-size budget, #114):
 * - `parse-vision-json-errors.ts`  — `VisionParseError`, fence stripping
 * - `parse-vision-json-enums.ts`   — allowed sets, synonym maps, JSON schema
 * - `parse-vision-json-coerce.ts`  — coercion + sentinel helpers
 */

import type { VisionDoc } from '../../db/schema.ts';
import { stripFences, VisionParseError } from './parse-vision-json-errors.ts';
import {
  ALLOWED_COMPOSITION,
  ALLOWED_LIGHTING,
  ALLOWED_SCENE_TYPE,
  ALLOWED_SHOT_TYPE,
  ALLOWED_TIME_OF_DAY,
  ALLOWED_WEATHER,
  COMPOSITION_SYNONYMS,
  ENUM_DEFAULTS,
  LIGHTING_SYNONYMS,
  SCENE_TYPE_SYNONYMS,
  SHOT_TYPE_SYNONYMS,
  TIME_OF_DAY_SYNONYMS,
  WEATHER_SYNONYMS,
} from './parse-vision-json-enums.ts';
import {
  asString,
  asStringArrayOrEmpty,
  COERCE_FAIL,
  coerceEnum,
  coerceIsScreenshot,
  coerceTextVisible,
  unwrapEnum,
} from './parse-vision-json-coerce.ts';

// Re-export the public surface so existing import sites
// (`./parse-vision-json.ts`) keep working unchanged.
export { VisionParseError, strippedRawFor } from './parse-vision-json-errors.ts';
export type { VisionParseReason } from './parse-vision-json-errors.ts';
export { VISION_DOC_JSON_SCHEMA } from './parse-vision-json-enums.ts';

/** Parse a model response into a typed `VisionDoc`. Throws
 * `VisionParseError` on any deviation from the schema. */
export function parseVisionJson(raw: string): VisionDoc {
  if (raw.length === 0) {
    throw new VisionParseError('empty-response', 'raw response was empty', raw);
  }

  const stripped = stripFences(raw.trim()).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new VisionParseError('not-json', msg, raw);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VisionParseError(
      'not-object',
      `expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      raw,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Classification-first: is_screenshot gates whether the scene fields
  // below are parsed normally or short-circuited to null. Mirrors the
  // prompt's own field order (see VISION_DOC_JSON_SCHEMA).
  const is_screenshot = coerceIsScreenshot(obj.is_screenshot);
  if (is_screenshot === COERCE_FAIL) {
    throw new VisionParseError(
      'wrong-type',
      'expected boolean (or coercible string / number)',
      raw,
      'is_screenshot',
    );
  }

  const caption = asString(obj.caption);
  if (caption === null) {
    throw new VisionParseError('wrong-type', 'expected string', raw, 'caption');
  }
  if (caption.trim().length === 0) {
    throw new VisionParseError('wrong-type', 'caption must not be empty', raw, 'caption');
  }

  const subjects = asStringArrayOrEmpty(obj.subjects);
  if (subjects === null) {
    throw new VisionParseError('wrong-type', 'expected string[] | null', raw, 'subjects');
  }

  const scene_type = is_screenshot
    ? null
    : unwrapEnum(
        coerceEnum(
          obj.scene_type,
          ALLOWED_SCENE_TYPE,
          SCENE_TYPE_SYNONYMS,
          ENUM_DEFAULTS.scene_type,
        ),
        'scene_type',
        obj.scene_type,
        raw,
        ALLOWED_SCENE_TYPE,
      );

  const setting = is_screenshot ? null : obj.setting === null ? null : asString(obj.setting);
  if (!is_screenshot && setting === null && obj.setting !== null) {
    throw new VisionParseError('wrong-type', 'expected string | null', raw, 'setting');
  }

  const activity = is_screenshot ? null : obj.activity === null ? null : asString(obj.activity);
  if (!is_screenshot && activity === null && obj.activity !== null) {
    throw new VisionParseError('wrong-type', 'expected string | null', raw, 'activity');
  }

  const time_of_day = is_screenshot
    ? null
    : unwrapEnum(
        coerceEnum(
          obj.time_of_day,
          ALLOWED_TIME_OF_DAY,
          TIME_OF_DAY_SYNONYMS,
          ENUM_DEFAULTS.time_of_day,
        ),
        'time_of_day',
        obj.time_of_day,
        raw,
        ALLOWED_TIME_OF_DAY,
      );

  const lighting = is_screenshot
    ? null
    : unwrapEnum(
        coerceEnum(obj.lighting, ALLOWED_LIGHTING, LIGHTING_SYNONYMS, ENUM_DEFAULTS.lighting),
        'lighting',
        obj.lighting,
        raw,
        ALLOWED_LIGHTING,
      );

  const weather = is_screenshot
    ? null
    : unwrapEnum(
        coerceEnum(obj.weather, ALLOWED_WEATHER, WEATHER_SYNONYMS, ENUM_DEFAULTS.weather),
        'weather',
        obj.weather,
        raw,
        ALLOWED_WEATHER,
      );

  // mood is unconstrained free text. Accept null → "neutral" (qwen
  // emits null on featureless images, and always on screenshots).
  const mood = obj.mood === null || obj.mood === undefined ? 'neutral' : asString(obj.mood);
  if (mood === null) {
    throw new VisionParseError('wrong-type', 'expected string | null', raw, 'mood');
  }

  const colors = asStringArrayOrEmpty(obj.colors);
  if (colors === null) {
    throw new VisionParseError('wrong-type', 'expected string[] | null', raw, 'colors');
  }

  const composition = is_screenshot
    ? null
    : unwrapEnum(
        coerceEnum(
          obj.composition,
          ALLOWED_COMPOSITION,
          COMPOSITION_SYNONYMS,
          ENUM_DEFAULTS.composition,
        ),
        'composition',
        obj.composition,
        raw,
        ALLOWED_COMPOSITION,
      );

  const text_visible = coerceTextVisible(obj.text_visible);
  if (text_visible === COERCE_FAIL) {
    throw new VisionParseError(
      'wrong-type',
      'expected string | null | string[]',
      raw,
      'text_visible',
    );
  }

  const notable_objects = asStringArrayOrEmpty(obj.notable_objects);
  if (notable_objects === null) {
    throw new VisionParseError('wrong-type', 'expected string[] | null', raw, 'notable_objects');
  }

  const shot_type = is_screenshot
    ? null
    : unwrapEnum(
        coerceEnum(obj.shot_type, ALLOWED_SHOT_TYPE, SHOT_TYPE_SYNONYMS, ENUM_DEFAULTS.shot_type),
        'shot_type',
        obj.shot_type,
        raw,
        ALLOWED_SHOT_TYPE,
      );

  return {
    caption,
    subjects,
    scene_type: scene_type as VisionDoc['scene_type'],
    setting,
    activity,
    time_of_day: time_of_day as VisionDoc['time_of_day'],
    lighting: lighting as VisionDoc['lighting'],
    weather: weather as VisionDoc['weather'],
    mood,
    colors,
    composition: composition as VisionDoc['composition'],
    text_visible,
    notable_objects,
    shot_type: shot_type as VisionDoc['shot_type'],
    is_screenshot,
    nudity: 'none',
  };
}
