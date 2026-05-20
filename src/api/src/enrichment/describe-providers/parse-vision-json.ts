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

/** Sentinel returned by `coerce*` helpers to signal "this input couldn't be
 * normalised". Distinct from a legitimate null/false result so the caller
 * can throw a `VisionParseError` only when the input was actually invalid. */
const COERCE_FAIL = Symbol("coerce-fail");

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

  const subjects = asStringArray(obj.subjects);
  if (subjects === null) {
    throw new VisionParseError("wrong-type", "expected string[]", raw, "subjects");
  }

  const scene_type = asString(obj.scene_type);
  if (scene_type === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "scene_type");
  }
  if (!ALLOWED_SCENE_TYPE.has(scene_type)) {
    throw new VisionParseError(
      "bad-enum",
      `got "${scene_type}"; allowed: ${[...ALLOWED_SCENE_TYPE].join(" | ")}`,
      raw,
      "scene_type",
    );
  }

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

  const time_of_day = asString(obj.time_of_day);
  if (time_of_day === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "time_of_day");
  }
  if (!ALLOWED_TIME_OF_DAY.has(time_of_day)) {
    throw new VisionParseError(
      "bad-enum",
      `got "${time_of_day}"; allowed: ${[...ALLOWED_TIME_OF_DAY].join(" | ")}`,
      raw,
      "time_of_day",
    );
  }

  const lighting = asString(obj.lighting);
  if (lighting === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "lighting");
  }
  if (!ALLOWED_LIGHTING.has(lighting)) {
    throw new VisionParseError(
      "bad-enum",
      `got "${lighting}"; allowed: ${[...ALLOWED_LIGHTING].join(" | ")}`,
      raw,
      "lighting",
    );
  }

  const weather = asString(obj.weather);
  if (weather === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "weather");
  }
  if (!ALLOWED_WEATHER.has(weather)) {
    throw new VisionParseError(
      "bad-enum",
      `got "${weather}"; allowed: ${[...ALLOWED_WEATHER].join(" | ")}`,
      raw,
      "weather",
    );
  }

  const mood = asString(obj.mood);
  if (mood === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "mood");
  }

  const colors = asStringArray(obj.colors);
  if (colors === null) {
    throw new VisionParseError("wrong-type", "expected string[]", raw, "colors");
  }

  const composition = asString(obj.composition);
  if (composition === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "composition");
  }
  if (!ALLOWED_COMPOSITION.has(composition)) {
    throw new VisionParseError(
      "bad-enum",
      `got "${composition}"; allowed: ${[...ALLOWED_COMPOSITION].join(" | ")}`,
      raw,
      "composition",
    );
  }

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

  const notable_objects = asStringArray(obj.notable_objects);
  if (notable_objects === null) {
    throw new VisionParseError(
      "wrong-type",
      "expected string[]",
      raw,
      "notable_objects",
    );
  }

  const shot_type = asString(obj.shot_type);
  if (shot_type === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "shot_type");
  }
  if (!ALLOWED_SHOT_TYPE.has(shot_type)) {
    throw new VisionParseError(
      "bad-enum",
      `got "${shot_type}"; allowed: ${[...ALLOWED_SHOT_TYPE].join(" | ")}`,
      raw,
      "shot_type",
    );
  }

  const indoor_outdoor = asString(obj.indoor_outdoor);
  if (indoor_outdoor === null) {
    throw new VisionParseError("wrong-type", "expected string", raw, "indoor_outdoor");
  }
  if (!ALLOWED_INDOOR_OUTDOOR.has(indoor_outdoor)) {
    throw new VisionParseError(
      "bad-enum",
      `got "${indoor_outdoor}"; allowed: ${[...ALLOWED_INDOOR_OUTDOOR].join(" | ")}`,
      raw,
      "indoor_outdoor",
    );
  }

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
