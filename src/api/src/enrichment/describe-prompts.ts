/**
 * Prompt text + prompt version for the describe (vision-LLM) worker.
 *
 * Split out of `enrichment-config.repo.ts` to keep that file under the
 * file-size budget. These are pure constants with no dependency on the
 * config repo; the repo re-exports them so existing import sites
 * (`describe.ts`, the parse-vision-json test) keep importing from
 * `enrichment-config.repo.ts` unchanged.
 */

export const DEFAULT_DESCRIBE_SYSTEM_PROMPT =
  'Describe this photo in one or two concise English sentences. ' +
  'Focus on the subject, scene and notable visual details. ' +
  'Avoid speculation about identity or location.';

/**
 * Structured-JSON prompt for the qwen2.5-vl describe stage.
 *
 * Emits a flat JSON object matching the `VisionDoc` schema in
 * `src/db/schema.ts`. Independently-queryable fields beat a single
 * free-text caption for search, filtering, and re-embedding.
 *
 * Non-obvious rules baked into the prompt:
 *
 * - "Do not begin with 'This image shows'…" — VLMs love this preamble
 *   and it pollutes embeddings because every caption then starts the
 *   same way, collapsing semantic differentiation.
 * - "Do not guess names of specific people" — qwen2.5-vl will invent
 *   names; we want generic descriptors here and let identity arrive
 *   via face recognition or manual tagging on a separate path.
 * - Return `null` rather than fabricating values — easier to dead-letter
 *   parse failures than to detect hallucinated content.
 *
 * Spec: `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`
 * §Prompt. Wired into the describe handler by ticket #149 alongside
 * the model swap; that commit also bumps `DESCRIBE_PROMPT_VERSION`.
 */
export const DEFAULT_DESCRIBE_VISION_PROMPT = `You are indexing a personal photo library. Analyze this image and return ONLY valid JSON matching this exact schema. No preamble, no markdown fences, no commentary — JSON only.

{
  "caption":         "1-2 sentence search-oriented description. Do not begin with 'This image shows', 'The image depicts', or similar. Subjects, action, setting, notable details.",
  "subjects":        ["array of subject types: person, child, adult, dog, cat, bird, building, vehicle, landscape, food, plant, etc."],
  "scene_type":      "indoor | outdoor | aerial | macro | studio | mixed",
  "setting":         "specific environment (kitchen, beach, forest, sports field, backyard, ...) or null",
  "activity":        "what is happening, or null for a static scene",
  "time_of_day":     "morning | midday | afternoon | golden hour | evening | night | unknown",
  "lighting":        "natural | artificial | mixed | low-light | backlit | flash",
  "weather":         "clear | cloudy | rainy | snowy | foggy | indoor | unknown",
  "mood":            "1-3 words",
  "colors":          ["dominant colors, max 5"],
  "composition":     "wide shot | close-up | portrait | landscape | aerial | macro | candid",
  "text_visible":    "any readable text in the image, or null",
  "notable_objects": ["distinctive objects, max 8"],
  "shot_type":       "action | static | candid | posed | architectural | nature | event",
  "indoor_outdoor":  "indoor | outdoor",
  "is_screenshot":   "true when this image is a screenshot of a phone/computer/app UI (including cropped screenshots and screenshots-of-screenshots), false for photographs and photos-of-screens",
  "nudity_detected": "true when this image contains nudity, false otherwise"
}

Rules:
- Return null when you cannot identify a field; do not invent.
- Do not guess names of specific people. Use generic descriptors (e.g. "child", "adult man").
- Output JSON only. No prose before or after the JSON object.`;

/**
 * `prompt_version` to stamp on `vision_meta` rows produced with
 * `DEFAULT_DESCRIBE_VISION_PROMPT`. Bumping this number triggers the
 * runtime to re-run the describe stage against every existing asset.
 *
 * History:
 *   1 — free-text `DEFAULT_DESCRIBE_SYSTEM_PROMPT` (llava era)
 *   2 — structured JSON `DEFAULT_DESCRIBE_VISION_PROMPT` (qwen2.5-vl)
 *   3 — adds `is_screenshot` boolean field (#175)
 *   4 — adds `nudity_detected` boolean field for auto-hide safety net
 */
export const DESCRIBE_VISION_PROMPT_VERSION = 4;
