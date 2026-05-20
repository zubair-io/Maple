/**
 * Strict parser for the qwen2.5-vl describe stage's structured-JSON
 * output. Used by `workers/stages/describe.ts` to convert the raw model
 * response into a typed `VisionDoc` (see `db/schema.ts`).
 *
 * Why strict: qwen2.5-vl sometimes wraps JSON in markdown fences, sometimes
 * adds preamble ("Sure, here is the JSON:"), and occasionally drops a
 * required field. We forgive the fence wrapper (always present in some
 * Ollama builds) but reject everything else — silently coercing a missing
 * key would poison the search index and the dead-letter triage UI is the
 * right surface for "the model produced garbage on this asset."
 *
 * Throws `VisionParseError` (a typed subclass of `Error`) with a truncated
 * snippet of the raw response in its message. The runtime then stamps
 * the message into `stages.describe.last_error` automatically.
 *
 * Spec: `docs/superpowers/specs/2026-05-19-qwen-vision-ocr-design.md`
 * §Failure modes.
 */

import type { VisionDoc } from "../../db/schema.ts";

/** Maximum bytes of the raw response we attach to error messages. Mongo
 * docs can hold MBs, but the dead-letter list is human-triaged in a UI
 * — keep messages bounded so the operator's terminal doesn't choke. */
const MAX_ERROR_SNIPPET_BYTES = 8 * 1024;

/** Markdown fence patterns qwen2.5-vl emits with surprising regularity.
 * Conservative: only strip a single matching fence pair, not arbitrary
 * code blocks within prose. */
const FENCE_OPEN = /^\s*```(?:json|JSON)?\s*\n?/;
const FENCE_CLOSE = /\n?```\s*$/;

const ALLOWED_SCENE_TYPE = new Set([
  "indoor",
  "outdoor",
  "aerial",
  "macro",
  "studio",
  "mixed",
]);
const ALLOWED_TIME_OF_DAY = new Set([
  "morning",
  "midday",
  "afternoon",
  "golden hour",
  "evening",
  "night",
  "unknown",
]);
const ALLOWED_LIGHTING = new Set([
  "natural",
  "artificial",
  "mixed",
  "low-light",
  "backlit",
  "flash",
]);
const ALLOWED_WEATHER = new Set([
  "clear",
  "cloudy",
  "rainy",
  "snowy",
  "foggy",
  "indoor",
  "unknown",
]);
const ALLOWED_COMPOSITION = new Set([
  "wide shot",
  "close-up",
  "portrait",
  "landscape",
  "aerial",
  "macro",
  "candid",
]);
const ALLOWED_SHOT_TYPE = new Set([
  "action",
  "static",
  "candid",
  "posed",
  "architectural",
  "nature",
  "event",
]);
const ALLOWED_INDOOR_OUTDOOR = new Set(["indoor", "outdoor"]);

/** Reason for the parse failure — useful for dead-letter triage grouping. */
export type VisionParseReason =
  | "not-json"
  | "not-object"
  | "missing-field"
  | "wrong-type"
  | "bad-enum"
  | "empty-response";

/** Short prefix of the raw snippet to embed in `error.message`. The stage
 * runtime persists only `err.message` into `stages.<name>.last_error`,
 * so this is what an operator sees in the dead-letter triage UI without
 * having to crack open the dead-letter doc. Full snippet stays available
 * on the `snippet` field for programmatic readers. */
const MESSAGE_SNIPPET_BYTES = 240;

export class VisionParseError extends Error {
  readonly reason: VisionParseReason;
  readonly field: string | null;
  /** Truncated raw response — capped at `MAX_ERROR_SNIPPET_BYTES`. */
  readonly snippet: string;

  constructor(reason: VisionParseReason, message: string, raw: string, field: string | null = null) {
    const snippet = truncateBytes(raw, MAX_ERROR_SNIPPET_BYTES);
    const preview = truncateBytes(raw, MESSAGE_SNIPPET_BYTES);
    super(
      `vision-parse[${reason}${field ? `:${field}` : ""}]: ${message} | raw: ${preview}`,
    );
    this.name = "VisionParseError";
    this.reason = reason;
    this.field = field;
    this.snippet = snippet;
  }
}

/** Byte-aware truncation. `String.slice` cuts UTF-16 code units, so a
 * multi-byte character near the boundary would let the result exceed
 * `maxBytes` — important because the snippet caps Mongo last_error +
 * dead-letter doc growth, not a character count. */
function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  // toString on an arbitrary byte boundary may leave a half-character at
  // the end — fine for human inspection.
  return buf.subarray(0, maxBytes).toString("utf8") + "…[truncated]";
}

/** Strip a single matching markdown fence pair, if present. Leaves
 * raw input alone when there isn't one. */
function stripFences(raw: string): string {
  const openMatch = FENCE_OPEN.exec(raw);
  if (!openMatch) return raw;
  const closeMatch = FENCE_CLOSE.exec(raw);
  if (!closeMatch) return raw; // open without close — let JSON.parse fail
  return raw.slice(openMatch[0].length, raw.length - closeMatch[0].length);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") return null;
    out.push(x);
  }
  return out;
}

/** Same as `asStringArray`, but `null`/`undefined` collapse to `[]`. qwen2.5-vl
 * returns `null` for these fields on featureless images (black/empty
 * frames) — treating that as "no subjects/colors/objects detected" is
 * more useful than dead-lettering the row. */
function asStringArrayOrEmpty(v: unknown): string[] | null {
  if (v === null || v === undefined) return [];
  return asStringArray(v);
}

/** Sentinel returned by `coerce*` helpers to signal "this input couldn't be
 * normalised". Distinct from a legitimate null/false result so the caller
 * can throw a `VisionParseError` only when the input was actually invalid. */
const COERCE_FAIL = Symbol("coerce-fail");

/** Distinguishes "the input wasn't a string at all" (wrong-type) from
 * "the input was a string but not in the allowed set / synonym map"
 * (bad-enum). Lets the call site preserve the error-reason taxonomy
 * dead-letter triage groups on. */
const COERCE_FAIL_TYPE = Symbol("coerce-fail-type");

/** qwen2.5-vl regularly returns is_screenshot as a string ("false"), a
 * number (0/1), or omits it. Coerce the common variants — anything truly
 * unparseable returns COERCE_FAIL so the caller dead-letters the row.
 * Missing / null / undefined defaults to `false`: an outdoor scene with
 * no `is_screenshot` field is overwhelmingly likely to be a real photo. */
function coerceIsScreenshot(v: unknown): boolean | typeof COERCE_FAIL {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return false;
  if (typeof v === "number") {
    if (v === 0) return false;
    if (v === 1) return true;
    return COERCE_FAIL;
  }
  if (typeof v === "string") {
    const norm = v.trim().toLowerCase();
    if (norm === "true" || norm === "yes" || norm === "1") return true;
    if (norm === "false" || norm === "no" || norm === "0" || norm === "") return false;
    return COERCE_FAIL;
  }
  return COERCE_FAIL;
}

/** Per-enum synonym maps. qwen2.5-vl regularly emits values that are
 * semantically equivalent to one of the allowed enum values but not
 * literally in the set — e.g. "partly cloudy" for `weather`, "day" for
 * `time_of_day`, "static" for `scene_type` (confused with `shot_type`).
 * Mapping these to their nearest allowed value is more useful than
 * dead-lettering the row. Keys are lowercased before lookup. */
const SCENE_TYPE_SYNONYMS: Record<string, string> = {
  // qwen sometimes confuses scene_type with shot_type and emits "static".
  static: "mixed",
};
const TIME_OF_DAY_SYNONYMS: Record<string, string> = {
  day: "midday",
  daytime: "midday",
  daylight: "midday",
  noon: "midday",
  dawn: "morning",
  sunrise: "morning",
  "early morning": "morning",
  "late morning": "midday",
  "early afternoon": "afternoon",
  "late afternoon": "afternoon",
  dusk: "evening",
  twilight: "evening",
  sunset: "golden hour",
  "late evening": "night",
  midnight: "night",
  "late night": "night",
};
const LIGHTING_SYNONYMS: Record<string, string> = {
  ambient: "natural",
  daylight: "natural",
  sunlight: "natural",
  dark: "low-light",
  dim: "low-light",
  "dimly lit": "low-light",
  unknown: "natural",
};
const WEATHER_SYNONYMS: Record<string, string> = {
  "partly cloudy": "cloudy",
  "partly sunny": "cloudy",
  "mostly cloudy": "cloudy",
  overcast: "cloudy",
  sunny: "clear",
  "clear sky": "clear",
  "clear skies": "clear",
  rain: "rainy",
  snow: "snowy",
  fog: "foggy",
  misty: "foggy",
  haze: "foggy",
  hazy: "foggy",
};
const COMPOSITION_SYNONYMS: Record<string, string> = {
  panorama: "wide shot",
  panoramic: "wide shot",
  closeup: "close-up",
  "macro shot": "macro",
  "aerial shot": "aerial",
};
const SHOT_TYPE_SYNONYMS: Record<string, string> = {
  motion: "action",
  dynamic: "action",
  still: "static",
  scenic: "nature",
  natural: "nature",
};
const INDOOR_OUTDOOR_SYNONYMS: Record<string, string> = {
  // qwen returns "unknown" for ambiguous frames. Real photos are
  // overwhelmingly outdoor in our corpus — bias toward outdoor.
  unknown: "outdoor",
  mixed: "outdoor",
  both: "outdoor",
  outside: "outdoor",
  inside: "indoor",
};

/** Per-enum default for null/undefined/missing inputs. Picked to match
 * the value qwen2.5-vl would most likely have emitted had it classified
 * the field — biased toward the "unknown" / least-informative legal
 * value rather than an arbitrary positive class. */
const ENUM_DEFAULTS = {
  scene_type: "mixed",
  time_of_day: "unknown", // already in the enum
  lighting: "natural",
  weather: "unknown", // already in the enum
  composition: "candid",
  shot_type: "static",
  indoor_outdoor: "outdoor",
} as const;

/** Coerce a value to a member of `allowed`. Resolution order:
 *   1. null/undefined → `defaultValue` (must itself be in `allowed`).
 *   2. non-string → COERCE_FAIL_TYPE (caller throws `wrong-type`).
 *   3. exact string match (post trim + lowercase).
 *   4. synonym map lookup (post trim + lowercase).
 *   5. otherwise COERCE_FAIL (caller throws `bad-enum`).
 *
 * The trim+lowercase normalisation is intentional — qwen2.5-vl
 * sometimes emits trailing whitespace or capitalisation drift. */
function coerceEnum(
  v: unknown,
  allowed: Set<string>,
  synonyms: Record<string, string>,
  defaultValue: string,
): string | typeof COERCE_FAIL | typeof COERCE_FAIL_TYPE {
  if (v === null || v === undefined) return defaultValue;
  if (typeof v !== "string") return COERCE_FAIL_TYPE;
  const norm = v.trim().toLowerCase();
  if (allowed.has(norm)) return norm;
  const mapped = synonyms[norm];
  if (mapped !== undefined && allowed.has(mapped)) return mapped;
  // Also accept the raw (pre-normalised) string if it happens to be in
  // the allowed set with original case — covers values like
  // "golden hour" where the enum value itself contains a space.
  if (allowed.has(v)) return v;
  return COERCE_FAIL;
}

/** Resolve a `coerceEnum` result into a concrete string, throwing the
 * right `VisionParseError` flavour for the failure mode. Keeps the call
 * sites in `parseVisionJson` from repeating the same two-branch dance.
 *
 * The reason taxonomy matters: dead-letter triage groups by `reason`,
 * so "the model returned 42 for an enum field" (wrong-type) needs to
 * stay distinct from "the model returned a string that isn't in the
 * allowed set" (bad-enum). */
function unwrapEnum(
  result: string | typeof COERCE_FAIL | typeof COERCE_FAIL_TYPE,
  field: string,
  rawValue: unknown,
  raw: string,
  allowed: Set<string>,
): string {
  if (result === COERCE_FAIL_TYPE) {
    throw new VisionParseError(
      "wrong-type",
      `expected string | null, got ${typeof rawValue}`,
      raw,
      field,
    );
  }
  if (result === COERCE_FAIL) {
    throw new VisionParseError(
      "bad-enum",
      `got ${JSON.stringify(rawValue)}; allowed: ${[...allowed].join(" | ")}`,
      raw,
      field,
    );
  }
  return result;
}

/** text_visible is often returned as a string array when multiple text
 * regions are visible (signs + a license plate). Join with newlines —
 * downstream consumers treat the field as opaque multi-line text. Empty
 * array, empty string, null, and undefined all collapse to null. */
function coerceTextVisible(v: unknown): string | null | typeof COERCE_FAIL {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length === 0 ? null : v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") return COERCE_FAIL;
      if (x.length > 0) parts.push(x);
    }
    return parts.length === 0 ? null : parts.join("\n");
  }
  return COERCE_FAIL;
}

/** Strip a fence wrapper if present and return the JSON body the parser
 * would consume. Exposed so callers (the describe stage) can compute
 * `raw_response_size` against the same string the parser saw, rather
 * than against the pre-strip text. */
export function strippedRawFor(raw: string): string {
  return stripFences(raw.trim()).trim();
}

/** Parse a model response into a typed `VisionDoc`. Throws
 * `VisionParseError` on any deviation from the schema. */
export function parseVisionJson(raw: string): VisionDoc {
  if (raw.length === 0) {
    throw new VisionParseError("empty-response", "raw response was empty", raw);
  }

  const stripped = stripFences(raw.trim()).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new VisionParseError("not-json", msg, raw);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VisionParseError(
      "not-object",
      `expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      raw,
    );
  }

  const obj = parsed as Record<string, unknown>;

  const caption = asString(obj.caption);
  if (caption === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "caption");
  }
  if (caption.trim().length === 0) {
    throw new VisionParseError(
      "wrong-type",
      "caption must not be empty",
      raw,
      "caption",
    );
  }

  const subjects = asStringArrayOrEmpty(obj.subjects);
  if (subjects === null) {
    throw new VisionParseError("wrong-type", "expected string[] | null", raw, "subjects");
  }

  const scene_type = unwrapEnum(
    coerceEnum(obj.scene_type, ALLOWED_SCENE_TYPE, SCENE_TYPE_SYNONYMS, ENUM_DEFAULTS.scene_type),
    "scene_type",
    obj.scene_type,
    raw,
    ALLOWED_SCENE_TYPE,
  );

  const setting = obj.setting === null ? null : asString(obj.setting);
  if (setting === null && obj.setting !== null) {
    throw new VisionParseError(
      "wrong-type",
      "expected string | null",
      raw,
      "setting",
    );
  }

  const activity = obj.activity === null ? null : asString(obj.activity);
  if (activity === null && obj.activity !== null) {
    throw new VisionParseError(
      "wrong-type",
      "expected string | null",
      raw,
      "activity",
    );
  }

  const time_of_day = unwrapEnum(
    coerceEnum(obj.time_of_day, ALLOWED_TIME_OF_DAY, TIME_OF_DAY_SYNONYMS, ENUM_DEFAULTS.time_of_day),
    "time_of_day",
    obj.time_of_day,
    raw,
    ALLOWED_TIME_OF_DAY,
  );

  const lighting = unwrapEnum(
    coerceEnum(obj.lighting, ALLOWED_LIGHTING, LIGHTING_SYNONYMS, ENUM_DEFAULTS.lighting),
    "lighting",
    obj.lighting,
    raw,
    ALLOWED_LIGHTING,
  );

  const weather = unwrapEnum(
    coerceEnum(obj.weather, ALLOWED_WEATHER, WEATHER_SYNONYMS, ENUM_DEFAULTS.weather),
    "weather",
    obj.weather,
    raw,
    ALLOWED_WEATHER,
  );

  // mood is unconstrained free text. Accept null → "neutral" (qwen
  // emits null on featureless images).
  const mood = obj.mood === null || obj.mood === undefined ? "neutral" : asString(obj.mood);
  if (mood === null) {
    throw new VisionParseError("wrong-type", "expected string | null", raw, "mood");
  }

  const colors = asStringArrayOrEmpty(obj.colors);
  if (colors === null) {
    throw new VisionParseError("wrong-type", "expected string[] | null", raw, "colors");
  }

  const composition = unwrapEnum(
    coerceEnum(obj.composition, ALLOWED_COMPOSITION, COMPOSITION_SYNONYMS, ENUM_DEFAULTS.composition),
    "composition",
    obj.composition,
    raw,
    ALLOWED_COMPOSITION,
  );

  const text_visible_raw = coerceTextVisible(obj.text_visible);
  if (text_visible_raw === COERCE_FAIL) {
    throw new VisionParseError(
      "wrong-type",
      "expected string | null | string[]",
      raw,
      "text_visible",
    );
  }
  const text_visible = text_visible_raw;

  const notable_objects = asStringArrayOrEmpty(obj.notable_objects);
  if (notable_objects === null) {
    throw new VisionParseError(
      "wrong-type",
      "expected string[] | null",
      raw,
      "notable_objects",
    );
  }

  const shot_type = unwrapEnum(
    coerceEnum(obj.shot_type, ALLOWED_SHOT_TYPE, SHOT_TYPE_SYNONYMS, ENUM_DEFAULTS.shot_type),
    "shot_type",
    obj.shot_type,
    raw,
    ALLOWED_SHOT_TYPE,
  );

  const indoor_outdoor = unwrapEnum(
    coerceEnum(obj.indoor_outdoor, ALLOWED_INDOOR_OUTDOOR, INDOOR_OUTDOOR_SYNONYMS, ENUM_DEFAULTS.indoor_outdoor),
    "indoor_outdoor",
    obj.indoor_outdoor,
    raw,
    ALLOWED_INDOOR_OUTDOOR,
  );

  const is_screenshot_raw = coerceIsScreenshot(obj.is_screenshot);
  if (is_screenshot_raw === COERCE_FAIL) {
    throw new VisionParseError(
      "wrong-type",
      "expected boolean (or coercible string / number)",
      raw,
      "is_screenshot",
    );
  }
  const is_screenshot = is_screenshot_raw;

  return {
    caption,
    subjects,
    scene_type: scene_type as VisionDoc["scene_type"],
    setting,
    activity,
    time_of_day: time_of_day as VisionDoc["time_of_day"],
    lighting: lighting as VisionDoc["lighting"],
    weather: weather as VisionDoc["weather"],
    mood,
    colors,
    composition: composition as VisionDoc["composition"],
    text_visible,
    notable_objects,
    shot_type: shot_type as VisionDoc["shot_type"],
    indoor_outdoor: indoor_outdoor as VisionDoc["indoor_outdoor"],
    is_screenshot,
  };
}
