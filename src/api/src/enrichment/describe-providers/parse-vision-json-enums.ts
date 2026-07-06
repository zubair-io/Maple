/**
 * Allowed-value sets, synonym maps, and defaults for the qwen3-vl
 * `VisionDoc` schema. Split out from `parse-vision-json.ts` so the
 * orchestrator stays under the file-size budget (#114).
 *
 * The JSON Schema at the bottom is fed to Ollama's `format` parameter so
 * the model's output is grammar-constrained at decode time. With it in
 * place the model literally cannot emit a value outside the allowed enum
 * or drop a required field. The synonym maps stay as defense in depth —
 * they handle older Ollama versions (< 0.5 don't honour `format`), future
 * provider swaps, and the rare case where the grammar engine emits a
 * token that doesn't match the schema in some edge case.
 */

export const ALLOWED_SCENE_TYPE = new Set([
  'indoor',
  'outdoor',
  'aerial',
  'macro',
  'studio',
  'mixed',
]);
export const ALLOWED_TIME_OF_DAY = new Set([
  'morning',
  'midday',
  'afternoon',
  'golden hour',
  'evening',
  'night',
  'unknown',
]);
export const ALLOWED_LIGHTING = new Set([
  'natural',
  'artificial',
  'mixed',
  'low-light',
  'backlit',
  'flash',
  'unknown',
]);
export const ALLOWED_WEATHER = new Set([
  'clear',
  'cloudy',
  'rainy',
  'snowy',
  'foggy',
  'indoor',
  'unknown',
]);
export const ALLOWED_COMPOSITION = new Set([
  'wide shot',
  'close-up',
  'portrait',
  'landscape',
  'aerial',
  'macro',
]);
export const ALLOWED_SHOT_TYPE = new Set([
  'action',
  'static',
  'candid',
  'posed',
  'architectural',
  'nature',
  'event',
]);
export const ALLOWED_NUDITY = new Set(['none', 'suggestive', 'explicit']);

/** Per-enum synonym maps. qwen regularly emits values that are
 * semantically equivalent to one of the allowed enum values but not
 * literally in the set — e.g. "partly cloudy" for `weather`, "day" for
 * `time_of_day`, "static" for `scene_type` (confused with `shot_type`).
 * Mapping these to their nearest allowed value is more useful than
 * dead-lettering the row. Keys are lowercased before lookup. */
export const SCENE_TYPE_SYNONYMS: Record<string, string> = {
  // qwen sometimes confuses scene_type with shot_type and emits "static".
  static: 'mixed',
};
export const TIME_OF_DAY_SYNONYMS: Record<string, string> = {
  day: 'midday',
  daytime: 'midday',
  daylight: 'midday',
  noon: 'midday',
  dawn: 'morning',
  sunrise: 'morning',
  'early morning': 'morning',
  'late morning': 'midday',
  'early afternoon': 'afternoon',
  'late afternoon': 'afternoon',
  dusk: 'evening',
  twilight: 'evening',
  sunset: 'golden hour',
  'late evening': 'night',
  midnight: 'night',
  'late night': 'night',
};
export const LIGHTING_SYNONYMS: Record<string, string> = {
  ambient: 'natural',
  daylight: 'natural',
  sunlight: 'natural',
  dark: 'low-light',
  dim: 'low-light',
  'dimly lit': 'low-light',
};
export const WEATHER_SYNONYMS: Record<string, string> = {
  'partly cloudy': 'cloudy',
  'partly sunny': 'cloudy',
  'mostly cloudy': 'cloudy',
  overcast: 'cloudy',
  sunny: 'clear',
  'clear sky': 'clear',
  'clear skies': 'clear',
  rain: 'rainy',
  snow: 'snowy',
  fog: 'foggy',
  misty: 'foggy',
  haze: 'foggy',
  hazy: 'foggy',
};
export const COMPOSITION_SYNONYMS: Record<string, string> = {
  panorama: 'wide shot',
  panoramic: 'wide shot',
  closeup: 'close-up',
  'macro shot': 'macro',
  'aerial shot': 'aerial',
  // qwen sometimes confuses composition with shot_type and emits one of
  // the shot_type enum values here. "candid" left the composition enum
  // in v5 (it's a shot-type concept), so it now maps here too instead of
  // round-tripping to itself.
  candid: 'wide shot',
  action: 'wide shot',
  static: 'wide shot',
  posed: 'portrait',
  architectural: 'wide shot',
  nature: 'landscape',
  event: 'wide shot',
};
export const SHOT_TYPE_SYNONYMS: Record<string, string> = {
  motion: 'action',
  dynamic: 'action',
  still: 'static',
  scenic: 'nature',
  natural: 'nature',
};

/** Per-enum default for null/undefined/missing inputs. Picked to match
 * the value qwen would most likely have emitted had it classified
 * the field — biased toward the "unknown" / least-informative legal
 * value rather than an arbitrary positive class. */
export const ENUM_DEFAULTS = {
  scene_type: 'mixed',
  time_of_day: 'unknown', // already in the enum
  lighting: 'unknown', // already in the enum
  weather: 'unknown', // already in the enum
  composition: 'wide shot',
  shot_type: 'static',
} as const;

/**
 * JSON Schema passed to Ollama's `format` parameter so the model's output
 * is constrained at decode time. Built from the same `ALLOWED_*` sets the
 * parser uses so the schema and the validator can never drift. `null` is
 * included on the nullable enum fields because the prompt asks the model
 * to return null on featureless images (or on every scene field when
 * `is_screenshot` is true); the parser maps null to the field's default
 * except where the field is meant to stay null (see `parse-vision-json.ts`).
 *
 * PROPERTY ORDER IS SIGNIFICANT — DO NOT ALPHABETIZE. Ollama's
 * grammar-constrained decode emits object properties in the order they
 * appear in this schema, and prompt v5's entire design rests on
 * classifying `is_screenshot` and `nudity` before the model commits to a
 * `caption` or any scene field, so those two fields must stay first.
 */
export const VISION_DOC_JSON_SCHEMA = {
  type: 'object',
  properties: {
    is_screenshot: { type: 'boolean' },
    nudity: { type: 'string', enum: [...ALLOWED_NUDITY] },
    caption: { type: 'string', minLength: 1 },
    subjects: { type: ['array', 'null'], items: { type: 'string' } },
    scene_type: { type: ['string', 'null'], enum: [...ALLOWED_SCENE_TYPE, null] },
    setting: { type: ['string', 'null'] },
    activity: { type: ['string', 'null'] },
    time_of_day: { type: ['string', 'null'], enum: [...ALLOWED_TIME_OF_DAY, null] },
    lighting: { type: ['string', 'null'], enum: [...ALLOWED_LIGHTING, null] },
    weather: { type: ['string', 'null'], enum: [...ALLOWED_WEATHER, null] },
    mood: { type: ['string', 'null'] },
    colors: { type: ['array', 'null'], items: { type: 'string' } },
    composition: { type: ['string', 'null'], enum: [...ALLOWED_COMPOSITION, null] },
    text_visible: { type: ['string', 'null'] },
    notable_objects: { type: ['array', 'null'], items: { type: 'string' } },
    shot_type: { type: ['string', 'null'], enum: [...ALLOWED_SHOT_TYPE, null] },
  },
  required: [
    'is_screenshot',
    'nudity',
    'caption',
    'subjects',
    'scene_type',
    'setting',
    'activity',
    'time_of_day',
    'lighting',
    'weather',
    'mood',
    'colors',
    'composition',
    'text_visible',
    'notable_objects',
    'shot_type',
  ],
} as const;
