/**
 * Prompt text + prompt version for the `video-describe` stage's structured
 * multi-frame output (#2158 design doc, "Prompt, schema, and trustworthy
 * timestamps").
 *
 * Distinct from `describe-prompts.ts` (the single-image `describe` stage's
 * prompt): a multi-frame request needs the model told explicitly that the
 * images are chronological samples, not independent photos, and the schema
 * is a summary + a scene list rather than one flat caption object.
 *
 * The model returns `frame_index` (a position in the ordered images it was
 * sent), never a timestamp — `parse-video-json.ts` maps that index back to
 * the sampler-owned timestamp, so a hallucinated time can never reach
 * storage. This mirrors why the vision-doc prompt asks for `is_screenshot`
 * before free text: constrain the model to values the stage can verify,
 * not values it has to trust.
 */

export const VIDEO_DESCRIBE_SYSTEM_PROMPT = `You are indexing a personal video library for search. You will receive several JPEG images, in order. They are frames SAMPLED CHRONOLOGICALLY from ONE video clip — not separate photos. Consecutive images may be seconds or minutes apart; do not assume continuous motion between them, and never invent what happens in the gaps you were not shown.

Return ONLY a valid JSON object matching this schema:

{
  "summary": "1-3 sentences summarizing the whole clip: subjects, setting, and how it changes across the frames you were shown.",
  "scenes": [
    {
      "frame_index": "integer — the 0-based position of this image in the order you received it",
      "caption": "1-2 sentences describing what THIS frame shows",
      "text_visible": "readable text transcribed verbatim from this frame, or null when nothing is legible"
    }
  ]
}

Rules:
- Include one scenes entry per image you were sent, in the same order, each with the correct frame_index.
- Describe only what is visible in each frame. Do not infer what happens between frames.
- Never guess real names of people. Use generic descriptors.
- summary should read as one coherent description of the clip, not a list of the individual frames.
- Output JSON only. No prose before or after the JSON object.

Example output for a 3-frame video of a birthday party:
{"summary": "A child blows out candles on a birthday cake at an indoor party, then opens presents with family gathered around a living room.", "scenes": [{"frame_index": 0, "caption": "A young child leans over a cake with lit candles at a dining table decorated with balloons.", "text_visible": "Happy Birthday"}, {"frame_index": 1, "caption": "The same child claps beside an open present box while two adults look on.", "text_visible": null}, {"frame_index": 2, "caption": "A wide shot of a living room with wrapping paper on the floor and several people seated on a couch.", "text_visible": null}]}`;

/**
 * Bumped whenever `VIDEO_DESCRIBE_SYSTEM_PROMPT` changes. Stamped on
 * `video_description_meta.prompt_version`; the `video-describe` stage's own
 * `targetVersion` is bumped alongside it (same convention as `describe.ts`
 * and `DESCRIBE_VISION_PROMPT_VERSION`) so a prompt edit forces every
 * existing row to re-run.
 *
 * History:
 *   1 — initial multi-frame summary + per-frame scene list.
 */
export const VIDEO_DESCRIBE_PROMPT_VERSION = 1;
