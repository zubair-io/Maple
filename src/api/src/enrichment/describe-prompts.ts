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
 * Structured-JSON prompt for the qwen3-vl describe stage.
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
 * - "Do not guess names of specific people" — qwen3-vl will invent
 *   names; we want generic descriptors here and let identity arrive
 *   via face recognition or manual tagging on a separate path.
 * - Return `null` rather than fabricating values — easier to dead-letter
 *   parse failures than to detect hallucinated content.
 *
 * v5 additions (see `DESCRIBE_VISION_PROMPT_VERSION` history below for the
 * full changelog) worth calling out here because they shape the schema
 * itself, not just wording:
 *
 * - Classification-first field order: `is_screenshot` and `nudity` are
 *   asked first, ahead of every scene field. Ollama's grammar-constrained
 *   decode emits JSON properties in schema order (see
 *   `VISION_DOC_JSON_SCHEMA` in `parse-vision-json-enums.ts`), so putting
 *   the classification fields first lets the model's own emitted
 *   classification condition what it writes into `caption` and the scene
 *   fields — instead of writing a confident caption before it has
 *   "decided" the image is a screenshot.
 * - `nudity` replaces the old bare `nudity_detected` boolean with a
 *   three-point ladder (`none | suggestive | explicit`) with explicit
 *   boundary definitions, because the boolean conflated ordinary family
 *   bath/beach photos and shirtless-man photos with actual exposure.
 * - Screenshot short-circuit: when `is_screenshot` is true, every scene
 *   field (`scene_type`, `setting`, `activity`, `time_of_day`, `lighting`,
 *   `weather`, `composition`, `shot_type`) is nulled instead of the model
 *   confidently fabricating a scene description for a phone/app UI.
 * - `text_visible` now asks for verbatim transcription (case + line order
 *   preserved, no translation/paraphrase) — it is the sole OCR source
 *   since the parallel Tesseract stage was removed in #158, so accuracy
 *   here directly gates search quality.
 *
 * Spec: `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`
 * §Prompt. Wired into the describe handler by ticket #149 alongside
 * the model swap; that commit also bumps `DESCRIBE_PROMPT_VERSION`.
 */
export const DEFAULT_DESCRIBE_VISION_PROMPT = `You are indexing a personal photo library. Analyze this image and return ONLY valid JSON matching this exact schema. No preamble, no markdown fences, no commentary — JSON only.

{
  "is_screenshot":   "boolean — true when this image is a screen capture of a phone, computer, or app UI (including cropped screenshots and screenshots-of-screenshots); false for photographs, including photos OF screens",
  "nudity":          "none | suggestive | explicit",
  "caption":         "1-2 sentence search-oriented description. Do not begin with 'This image shows', 'The image depicts', or similar. Lead with the subject and action, then setting. Include distinctive searchable details: clothing colors, number of people, animal breeds, landmarks, vehicle types.",
  "subjects":        ["subject types present: person, child, adult, dog, cat, bird, building, vehicle, landscape, food, plant, etc."],
  "scene_type":      "indoor | outdoor | aerial | macro | studio | mixed",
  "setting":         "specific environment (kitchen, beach, forest, sports field, backyard, ...) or null",
  "activity":        "what is happening, or null for a static scene",
  "time_of_day":     "morning | midday | afternoon | golden hour | evening | night | unknown",
  "lighting":        "natural | artificial | mixed | low-light | backlit | flash | unknown",
  "weather":         "clear | cloudy | rainy | snowy | foggy | indoor | unknown",
  "mood":            "1-3 words, e.g. joyful, serene, tense, festive, somber",
  "colors":          ["dominant colors, max 5"],
  "composition":     "wide shot | close-up | portrait | landscape | aerial | macro",
  "text_visible":    "readable text transcribed verbatim — preserve case and line order; include signs, labels, and on-screen text; null when nothing is legible; do not translate or paraphrase",
  "notable_objects": ["distinctive objects, max 8"],
  "shot_type":       "action | static | candid | posed | architectural | nature | event"
}

Definitions:
- "nudity" is "explicit" when exposed genitals, exposed buttocks, or exposed female breasts/nipples are visible — including in art, on statues, or on a screen within the image. "suggestive" means sexualized posing or underwear/lingerie-focused framing without exposure. "none" covers everything else, including swimwear, shirtless men, and ordinary bath or beach family photos.

Rules:
- Decide "is_screenshot" first. If true: set "scene_type", "setting", "activity", "time_of_day", "lighting", "weather", "composition", and "shot_type" to null; name the app or website in "caption"; transcribe the main on-screen text in "text_visible".
- Return null when you cannot identify a field; never invent a value.
- Do not guess names of specific people. Use generic descriptors (e.g. "child", "adult").
- Output JSON only. No prose before or after the JSON object.

Example output for an ordinary photo:
{"is_screenshot": false, "nudity": "none", "caption": "A girl in a blue jersey kicks a football across a wet grass pitch while two teammates run behind her.", "subjects": ["child", "person"], "scene_type": "outdoor", "setting": "sports field", "activity": "playing football", "time_of_day": "afternoon", "lighting": "natural", "weather": "cloudy", "mood": "energetic", "colors": ["green", "blue", "white"], "composition": "wide shot", "text_visible": null, "notable_objects": ["football", "goal net"], "shot_type": "action"}

Example output for a screenshot:
{"is_screenshot": true, "nudity": "none", "caption": "Screenshot of a maps navigation app showing a driving route to Portland with a 42-minute ETA.", "subjects": [], "scene_type": null, "setting": null, "activity": null, "time_of_day": null, "lighting": null, "weather": null, "mood": null, "colors": ["white", "blue"], "composition": null, "text_visible": "42 min\\n28 miles\\nFastest route to Portland", "notable_objects": ["map"], "shot_type": null}`;

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
 *   5 — v5: classification-first field order, nudity ladder
 *       (none|suggestive|explicit), screenshot short-circuit, verbatim
 *       OCR for text_visible, drops indoor_outdoor, removes candid from
 *       composition; ships with the qwen3-vl:8b default
 */
export const DESCRIBE_VISION_PROMPT_VERSION = 5;
