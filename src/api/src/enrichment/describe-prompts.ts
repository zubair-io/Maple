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
 * Structured-JSON prompt for the describe stage's locked vision model.
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
 * - "Do not guess names of specific people" — the model will invent
 *   names; we want generic descriptors here and let identity arrive
 *   via face recognition or manual tagging on a separate path.
 * - Return `null` rather than fabricating values — easier to dead-letter
 *   parse failures than to detect hallucinated content.
 * - Classification-first field order: `is_screenshot` and `people_count`
 *   are asked ahead of every descriptive field. Ollama's
 *   grammar-constrained decode emits JSON properties in schema order (see
 *   `VISION_DOC_JSON_SCHEMA` in `parse-vision-json-enums.ts`), so putting
 *   the classification fields first lets the model's own emitted
 *   classification condition what it writes into `caption` and the scene
 *   fields — instead of writing a confident caption before it has
 *   "decided" the image is a screenshot, or naming "a couple" in prose
 *   before it has counted the people.
 * - Screenshot short-circuit: when `is_screenshot` is true, every scene
 *   field (`scene_type`, `setting`, `activity`, `time_of_day`, `lighting`,
 *   `weather`, `framing`, `shot_type`) is nulled instead of the model
 *   confidently fabricating a scene description for a phone/app UI.
 * - `text_visible` asks for verbatim transcription (case + line order
 *   preserved, no translation/paraphrase) — it is the sole OCR source
 *   since the parallel Tesseract stage was removed in #158, so accuracy
 *   here directly gates search quality.
 *
 * v7 additions (see `DESCRIBE_VISION_PROMPT_VERSION` history below) worth
 * calling out here because they shape the schema itself, not just wording:
 *
 * - `people_count` gives search a numeric handle ("photos with more than
 *   five people") that parsing it back out of the caption never could,
 *   and the "count first, then caption" rule stops the model writing
 *   "a couple walks…" over a frame holding four people.
 * - `tags` is a deliberately flat, redundant keyword bag. The caption is
 *   prose and tokenises unevenly; a keyword list gives `search_blob` a
 *   dense, dependable set of terms per asset.
 * - `composition` became `framing` and lost `portrait`/`landscape`/
 *   `aerial`. That enum mixed three orthogonal ideas — how tight the
 *   shot is, which way round the frame is, and where the camera was —
 *   so its value was never dependable for filtering. `framing` now
 *   carries only shot tightness; vantage lives in `scene_type`
 *   (`aerial`, `macro`) and orientation is derivable from EXIF.
 * - `notable_objects` carries an explicit exclusion list. Without one the
 *   model fills all eight slots with "people", "sky", "trees" — terms
 *   already covered by `subjects`, which crowd out the distinctive
 *   objects the field exists to capture.
 * - The caption rules gained few-shot GOOD/BAD examples: stating a
 *   density target in prose ("include distinctive details") moves the
 *   model far less than showing it two captions at the target density
 *   and one below it.
 * - "Describe only what is visible. Do not infer relationships" — the
 *   model reads three people at a table as "a family", which is both
 *   unverifiable and actively wrong as a search term.
 *
 * Spec: `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`
 * §Prompt. Wired into the describe handler by ticket #149 alongside
 * the model swap; that commit also bumps `DESCRIBE_PROMPT_VERSION`.
 */
export const DEFAULT_DESCRIBE_VISION_PROMPT = `You are indexing a personal photo library for search. Analyze this image and return ONLY a valid JSON object.

Schema:

{
  "is_screenshot":   "boolean — true only for screen captures of UI. Photos OF physical screens are false.",
  "people_count":    "integer — people visible in the photo, counting partially visible people. 0 for screenshots and photos with no people.",
  "caption":         "1-3 sentences, search-oriented. See caption rules.",
  "tags":            ["8-15 flat lowercase keywords for search: subjects, objects, setting, activity, colors. No sentences."],
  "subjects":        ["subject types present: person, child, teen, adult, elderly adult, dog, vehicle, food, landscape, ..."],
  "scene_type":      "indoor | outdoor | aerial | macro | studio | mixed",
  "setting":         "specific environment: backyard deck, kitchen, beach, ... or null",
  "activity":        "what is happening; null only for static scenes with no action",
  "time_of_day":     "morning | midday | afternoon | golden hour | evening | night | unknown",
  "lighting":        "natural | artificial | mixed | low-light | backlit | flash | unknown",
  "weather":         "clear | cloudy | rainy | snowy | foggy | indoor | unknown",
  "mood":            "1-3 words, e.g. joyful, serene, tense, festive, somber",
  "colors":          ["dominant colors, max 5, dominant first"],
  "framing":         "wide | medium | close-up | macro",
  "text_visible":    "readable text transcribed verbatim — preserve case and line order; null when nothing is legible; do not translate or paraphrase",
  "notable_objects": ["distinctive specific objects, max 8"],
  "shot_type":       "action | static | candid | posed | architectural | nature | event"
}

Caption rules — this field powers text search, so pack it with retrievable specifics:
- Lead with subjects and action, then setting. Never open with "This image shows" or similar.
- Include when present: number of people and approximate ages (child/teen/adult/elderly), clothing colors, hair, animal breeds, vehicle makes/types, landmarks, assistive devices, sports gear, unusual objects.
- Describe only what is visible. Do not infer relationships (say "three people," not "a family").

Examples of the target caption density (different photos, not this one):
- GOOD: "A golden retriever shakes off water at the edge of a rocky lake beach while a man in a red rain jacket holds a tennis ball launcher. Overcast sky, pine trees across the water."
- GOOD: "Two children in aprons decorate a sheet cake with blue frosting at a white kitchen island; a stand mixer and scattered sprinkle jars sit nearby."
- BAD: "A dog plays outside near a person." (too generic — no breed, colors, objects, or setting detail)

Field rules:
- Count people first, before writing the caption. The caption must be consistent with people_count.
- notable_objects: never include generic scene elements like "people", "person", "clothing", "trees", "sky", "grass". Good entries: "red mobility scooter", "stand mixer", "tennis ball launcher". Return [] if nothing distinctive.
- weather: infer from light and shadows. Bright sun with hard shadows = "clear". Use "indoor" for indoor scenes; "unknown" only when genuinely ambiguous.
- If is_screenshot is true: set scene_type, setting, activity, time_of_day, lighting, weather, framing, and shot_type to null; set people_count to 0; name the app or website in the caption; transcribe the main on-screen text in text_visible.
- Never guess real names of people. Use generic descriptors.
- Use null rather than inventing a value.
- Output JSON only. No prose before or after the JSON object.

Example output for an ordinary photo:
{"is_screenshot": false, "people_count": 3, "caption": "A girl in a blue jersey kicks a football across a wet grass pitch while two teammates in white run behind her. Floodlights and an empty metal bleacher stand beyond the touchline.", "tags": ["football", "soccer", "children", "sports field", "grass", "blue jersey", "running", "team", "outdoor", "wet"], "subjects": ["child", "person"], "scene_type": "outdoor", "setting": "sports field", "activity": "playing football", "time_of_day": "afternoon", "lighting": "natural", "weather": "cloudy", "mood": "energetic", "colors": ["green", "blue", "white"], "framing": "wide", "text_visible": null, "notable_objects": ["football", "goal net", "metal bleacher"], "shot_type": "action"}

Example output for a screenshot:
{"is_screenshot": true, "people_count": 0, "caption": "Screenshot of a maps navigation app showing a driving route to Portland with a 42-minute ETA.", "tags": ["screenshot", "maps", "navigation", "route", "portland", "eta", "app", "driving"], "subjects": [], "scene_type": null, "setting": null, "activity": null, "time_of_day": null, "lighting": null, "weather": null, "mood": null, "colors": ["white", "blue"], "framing": null, "text_visible": "42 min\\n28 miles\\nFastest route to Portland", "notable_objects": ["map"], "shot_type": null}`;

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
 *   6 — v6: remove nudity classification and auto-hide logic
 *   7 — v7: adds `people_count` and `tags`; `composition` → `framing`
 *       (wide|medium|close-up|macro, dropping the orientation/vantage
 *       values); caption grows to 1-3 sentences with few-shot density
 *       examples and a no-inferred-relationships rule; notable_objects
 *       gains a generic-term exclusion list; weather gains a
 *       light/shadow inference rule. Shipped with a gemma4:12b default
 *       that moved to gemma4:latest in #2736; v7 is model-agnostic
 */
export const DESCRIBE_VISION_PROMPT_VERSION = 7;
