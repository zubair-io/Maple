# Qwen2.5-VL captions, structured vision metadata, and OCR refresh

Status: draft
Owner: zubair
Date: 2026-05-19
Tracking issue: [#144](https://github.com/zubair-io/Maple/issues/144)
Sub-issues: [#145](https://github.com/zubair-io/Maple/issues/145) · [#146](https://github.com/zubair-io/Maple/issues/146) · [#147](https://github.com/zubair-io/Maple/issues/147) · [#148](https://github.com/zubair-io/Maple/issues/148) · [#149](https://github.com/zubair-io/Maple/issues/149) · [#150](https://github.com/zubair-io/Maple/issues/150) · [#151](https://github.com/zubair-io/Maple/issues/151) · [#152](https://github.com/zubair-io/Maple/issues/152) · [#153](https://github.com/zubair-io/Maple/issues/153)

## Summary

Replace the current free-text `llava` caption with a **single qwen2.5-vl:7b pass** that
emits **structured JSON** (caption, subjects, scene, activity, mood, colors,
composition, visible text, notable objects, shot type, …). The same pass
subsumes OCR for the search-blob path; Tesseract stays as an opt-in
word-level-bbox engine for document workflows but is no longer the default.

This is a Maple-native take on a rough spec written before seeing the
existing indexer. Most of the rough spec is already built — what
actually needs to change is calibrated below in **The Diff**.

## Why this, why now

- The current `description` field is free text, which collapses everything
  into one embedding-unfriendly blob and is useless for faceted filtering
  ("show me outdoor sports", "drone photos with text in them").
- Tesseract reliably hallucinates text on textureless photos (already
  worked around by a 60-confidence gate in `workers/stages/ocr.ts:103`).
  qwen2.5-vl reads scene text well enough that we get OCR *and* a caption
  in one inference for the same VRAM budget — fewer moving parts.
- qwen2.5-vl:7b runs on a 24 GB box (phoebe) under Ollama with room for
  one parallel slot. Per-image latency is acceptable for a background
  enrichment stage (target: < 15s on the 1280-px preview).

## What exists today (the load-bearing context)

| Component | Status | Where |
|---|---|---|
| Two-phase indexer (skeleton + async enrichment workers) | Built | `src/api/src/indexer/`, `docs/indexer-enrichment.md` |
| Stage-controller runtime (claim / retry / dead-letter / lease) | Built | `src/api/src/workers/runtime/` |
| Ollama describe provider | Built | `src/api/src/enrichment/describe-providers/ollama.ts` |
| Anthropic / OpenAI / Gemini describe providers | Built | same dir |
| Tesseract OCR stage with per-word bboxes and a confidence gate | Built | `src/api/src/workers/stages/ocr.ts` |
| `description` (free text) + `description_meta` (provider, model, prompt_version, …) on `AssetDoc` | Built | `src/api/src/db/schema.ts:108` |
| `ocr_text` + `ocr_words` + `ocr_meta` on `AssetDoc` | Built | `src/api/src/db/schema.ts:110-129` |
| `MAPLE_DESCRIBE_MODEL`, `MAPLE_DESCRIBE_PROVIDER`, `MAPLE_DESCRIBE_SYSTEM_PROMPT` env knobs + DB overrides | Built | `src/api/src/enrichment/enrichment-config.repo.ts` |
| Thumbnail cache (512 px JPEG) consumed by describe + OCR | Built | `src/api/src/workers/stages/thumb.ts`, `src/api/src/fs/xmp.ts` (`cachePathFor`) |
| `search_blob` recomputed in the `meili` stage and indexed in Meilisearch | Built | `src/api/src/workers/stages/meili.ts` |
| Stage `targetVersion` + `prompt_version` versioning so model/prompt swaps trigger automatic re-run | Built | `defineStage`, `description_meta.prompt_version` |
| Reverse geocode, face detect, EXIF, hash | Built | various |

What is **not** built and not in scope here:
- Vector embeddings + vector DB. The rough spec proposed Qdrant; we
  defer to a separate brief. Reasoning in [Out of scope](#out-of-scope).

## The diff

Concretely, this work is:

1. **Preview-size cache layer.** Add a **1280 px long-edge JPEG** alongside
   the existing 512 px thumb. The 512 px thumb is too small for reliable
   captions or OCR on a 24 MP photo. Cached as
   `cachePathFor(path, "previews")` so it sits next to `thumbs/` on disk.
2. **Structured `vision.*` subdoc on `AssetDoc`.** New typed `VisionDoc`
   captures caption, subjects[], scene_type, setting, activity,
   time_of_day, lighting, weather, mood, colors[], composition,
   text_visible, notable_objects[], shot_type, indoor_outdoor. Plus a
   `vision_meta` with provider / model / prompt_version / generated_at /
   raw_response_size.
3. **New prompt that emits strict JSON.** Specific anti-patterns: no
   "This image shows" preamble, no guessing of specific people's
   names, return `null` rather than inventing. Constants live in
   `enrichment-config.repo.ts` and bump `DESCRIBE_PROMPT_VERSION` to 2
   so existing rows re-run.
4. **Strict JSON parser with dead-letter capture.** Reject on missing
   keys or wrong types. Failures route through the existing
   `dead-letter.repo.ts` for human triage — never silent skip.
5. **Swap the describe stage to `qwen2.5-vl:7b` and the preview cache
   path.** Default Ollama model changes from `llava:latest` to
   `qwen2.5-vl:7b`. Describe handler reads `cachePathFor(path,
   "previews")` instead of `"thumbs"`. Bump stage `targetVersion` from
   1 to 2.
6. **OCR sourced from `vision.text_visible`.** When the vision stage
   completes, `ocr_text = vision.text_visible ?? ""` and `ocr_meta =
   { engine: "qwen2.5-vl", engine_version: <model tag>, generated_at,
   mean_confidence: null }`. The Tesseract stage stays
   `pausedOnFirstBoot: true` and remains opt-in for operators who need
   word-level bboxes (document scanning, sign-language overlays).
   `ocr_meta.engine` becomes a union: `"tesseract" | "qwen2.5-vl"`.
7. **`search_blob` fans in the structured fields.** The `meili` stage
   composes:
   ```
   caption + " " + subjects.join(" ") + " " + setting + " " + activity
     + " " + notable_objects.join(" ") + " " + text_visible + " " + place.search_blob
   ```
   so existing typo-tolerant text search benefits immediately without
   needing vectors.
8. **Web UI: inspector chips + browse facets.** Inspector renders
   subject / scene / setting / mood as chips. Browse adds facet filters
   on `vision.scene_type`, `vision.activity`, `vision.subjects`.
   Apple-side surfacing is deferred to a follow-up (the Swift inspector
   panel evolves on its own cadence — punt to a separate ticket once
   the API contract is stable).
9. **Docs: `indexer-enrichment.md` + `sidecar-schema.md`.** Document
   the new `vision` subdoc, the prompt version, the OCR engine union,
   and that vision data is database-only (not written to XMP — see
   below).

## Design

### Data model

Add to `src/api/src/db/schema.ts`:

```ts
export interface VisionDoc {
  /** 1–2 sentence caption. Same content as the top-level `description`
   *  field; duplicated here so the structured doc is self-contained. */
  caption: string;
  /** Categorical subject types: "person", "child", "adult", "dog", … */
  subjects: string[];
  scene_type: "indoor" | "outdoor" | "aerial" | "macro" | "studio" | "mixed";
  /** Free-text but constrained vocabulary, e.g. "kitchen", "beach". */
  setting: string | null;
  /** What's happening, or null for a static scene. */
  activity: string | null;
  time_of_day:
    | "morning" | "midday" | "afternoon" | "golden hour"
    | "evening" | "night" | "unknown";
  lighting: "natural" | "artificial" | "mixed" | "low-light" | "backlit" | "flash";
  weather: "clear" | "cloudy" | "rainy" | "snowy" | "foggy" | "indoor" | "unknown";
  /** 1–3 words. */
  mood: string;
  /** Dominant colors, max 5. */
  colors: string[];
  composition:
    | "wide shot" | "close-up" | "portrait" | "landscape"
    | "aerial" | "macro" | "candid";
  /** Any readable text in the image, or null. Replaces Tesseract output. */
  text_visible: string | null;
  /** Distinctive objects, max 8. */
  notable_objects: string[];
  shot_type:
    | "action" | "static" | "candid" | "posed"
    | "architectural" | "nature" | "event";
  indoor_outdoor: "indoor" | "outdoor";
}

export interface VisionMeta {
  provider: "ollama" | "anthropic" | "openai" | "gemini";
  model: string;
  prompt_version: number;
  generated_at: string;
  /** Bytes of the model's raw JSON response. Helps spot truncation. */
  raw_response_size: number;
}
```

Extend `AssetDoc`:

```ts
vision?: VisionDoc | null;
vision_meta?: VisionMeta | null;
ocr_meta?: {
  engine: "tesseract" | "qwen2.5-vl";
  engine_version: string;
  generated_at: string;
  mean_confidence: number | null; // null when engine is qwen2.5-vl
} | null;
```

Keep the existing top-level `description: string | null` as the
canonical free-text caption for backward compatibility — clients
already read it. New code reads `vision.caption` directly.

### Stage changes

```
discover → hash → exif → thumb → preview ┬→ describe (qwen2.5-vl)
                                          ├→ face
                                          ├→ ocr (tesseract, paused by default)
                                          └→ geocode
                       describe ──────────→ meili (fans everything in)
```

- New **`preview`** stage between `thumb` and `describe`, producing the
  1280-px JPEG. `dependsOn: ["thumb"]`. Idempotent.
- **`describe`** depends on `preview` instead of `thumb`. Reads the
  preview, calls Ollama with the structured-JSON prompt, parses
  strictly, writes both the `description` field (caption text) and the
  `vision` subdoc, plus `ocr_text` + `ocr_meta` from
  `vision.text_visible`. `targetVersion: 2`.
- **`ocr`** (Tesseract) stays as-is but `pausedOnFirstBoot` remains
  `true`. Precedence when both have run: Tesseract wins because it
  provides word-level bboxes (the reason an operator would enable it
  in the first place). The describe handler only writes `ocr_text` /
  `ocr_meta` when `ocr_meta` is null **or**
  `ocr_meta.engine === "qwen2.5-vl"`. Engine identity travels in
  `ocr_meta.engine`; `engine_version` carries the concrete tag —
  `"qwen2.5-vl:7b"` for the VLM path, the Tesseract semver for the
  classical path.
- **`meili`** fan-in updated to compose the new search-blob string.

### Prompt

Stored as `DEFAULT_DESCRIBE_SYSTEM_PROMPT` constant in
`enrichment-config.repo.ts`. Override via DB config (existing) or
`MAPLE_DESCRIBE_SYSTEM_PROMPT` env (existing). Bumped
`DESCRIBE_PROMPT_VERSION` to 2 to invalidate stale rows.

```
You are indexing a personal photo library. Analyze this image and return
ONLY valid JSON matching this exact schema. No preamble, no markdown,
no commentary — JSON only.

{
  "caption":         "1–2 sentence search-oriented description. Do not begin with 'This image shows', 'The image depicts', or similar. Subjects, action, setting, notable details.",
  "subjects":        ["array of subject types: person, child, adult, dog, cat, bird, building, vehicle, landscape, food, plant, etc."],
  "scene_type":      "indoor | outdoor | aerial | macro | studio | mixed",
  "setting":         "specific environment (kitchen, beach, forest, sports field, backyard, …) or null",
  "activity":        "what is happening, or null for a static scene",
  "time_of_day":     "morning | midday | afternoon | golden hour | evening | night | unknown",
  "lighting":        "natural | artificial | mixed | low-light | backlit | flash",
  "weather":         "clear | cloudy | rainy | snowy | foggy | indoor | unknown",
  "mood":            "1–3 words",
  "colors":          ["dominant colors, max 5"],
  "composition":     "wide shot | close-up | portrait | landscape | aerial | macro | candid",
  "text_visible":    "any readable text in the image, or null",
  "notable_objects": ["distinctive objects, max 8"],
  "shot_type":       "action | static | candid | posed | architectural | nature | event",
  "indoor_outdoor":  "indoor | outdoor"
}

Rules:
- Return null when you cannot identify a field; do not invent.
- Do not guess names of specific people. Use generic descriptors (e.g. "child", "adult man").
- Output JSON only. No prose before or after.
```

### Why preview is a *new* stage rather than a wider thumb

- The 512 px thumb is consumed by the Browse grid via `<img>` tags
  expecting that exact pixel budget. Changing it would force a one-time
  invalidation of every cached thumb on disk and re-encoding every
  display.
- The two artifacts have different consumers, different lifetimes
  (the grid thumb stays hot in the browser cache; the preview is
  read once per enrichment run then can be evicted), and different
  cadences (thumbs may eventually move to a multi-resolution scheme;
  the VLM preview is fixed at 1280 px).
- A separate stage keeps the dependency DAG honest and lets the
  preview be deleted independently when an asset is removed.

### Why we are *not* writing vision to XMP

Maple's load-bearing principle says XMP is the contract. Vision-derived
metadata is derived, not authored: it is reproducible from the bytes,
versioned by `(model, prompt_version)`, and re-runnable. Burning it
into the XMP sidecar would mean:

- Sidecar writes on every re-caption (cheap on disk, expensive on
  Apple-side sidecar diff logic).
- Sidecar bloat (the structured vision doc is ~1 KB per asset).
- A backwards-compat question every time the schema changes.

User-authored overrides (a user typing their own caption) **do** go to
XMP — that's already handled by the existing `description`/keyword
paths. The new `vision.*` doc is database-only. This matches how face
detections and reverse-geocoded place are persisted today.

### Failure modes

- **Model returns prose, not JSON.** Strict parser rejects → routed
  through `dead-letter.repo.ts` with the raw response. Already wired
  into the runtime.
- **Model returns JSON with missing keys.** Same path. Operator triages
  in `/settings/workers` (existing UI).
- **Model name unavailable on Ollama host.** Existing `health()` check
  in `ollama.ts:59` catches at boot; falls back to paused-with-error
  state.
- **Preview generation fails (corrupt JPEG, libvips OOM).** Existing
  stage error handling retries up to `maxAttempts`, then marks done
  with `skip` semantics so describe can short-circuit cleanly.

### Performance

- 1280-px JPEG preview: ~1 ms decode from the existing thumb-cache
  encoder pathway.
- qwen2.5-vl:7b on phoebe @ 1280 px input: ~8–12 s per image (24 GB
  RAM, single slot). `OLLAMA_NUM_PARALLEL=2` would double throughput
  but pushes VRAM past safe limits with the 7 B model.
- Sequential indexing of 10 000 photos: ~22–33 hours. Acceptable for
  one-off backfill; resumable via the existing per-asset bookkeeping
  so progress survives restarts.

### Migration / rollout

1. Land preview stage + schema fields behind defaults (paused
   describe stage still works with the *old* model + prompt).
2. Land the new prompt + structured parser, bumping `prompt_version`
   and `targetVersion` to 2.
3. Operator flips the model from `llava:latest` to `qwen2.5-vl:7b` in
   `/settings/workers` (the existing UI). Runtime re-runs everything.
4. Web UI ships behind a feature flag or just lights up when the
   fields are populated (Angular renders gracefully when `vision` is
   null).

## Out of scope

- **Embeddings + vector search.** Rough spec proposed
  `nomic-embed-text` + Qdrant. Deferred. Reason: Maple already has
  Meilisearch for typo-tolerant text + facet search; structured
  `vision.*` fields plus a fan-in `search_blob` cover the headline use
  cases ("drone photos from outdoor sports") without new
  infrastructure. We will write a separate brief if facet+text search
  proves insufficient.
- **Apple-side UI for vision fields.** API contract lands first; Apple
  surface follows on its own ticket.
- **Re-captioning when qwen3-vl ships.** Already covered by the
  existing `targetVersion` mechanism — bump the number, runtime does
  the rest.
- **Splitting panoramas into thirds before captioning.** Maybe later;
  for now we feed the panorama as-is and accept the center bias.

## Open questions

- Do we want a per-image cost meter for Ollama runs? Today
  `describe-spend.repo.ts` exists for paid providers; we will skip it
  for Ollama (cost = 0) but the schema already supports it.
- Should `vision.text_visible` populate `ocr_words` with one
  zero-bbox entry per word, so the Meilisearch index treats it
  identically to Tesseract output? Lean **no** for v1 — leave
  `ocr_words` as Tesseract's exclusive territory and let
  `search_blob` carry the text.

## Issue breakdown

A parent tracking issue links the following sub-issues. Order is the
suggested build order; nothing strictly blocks except as noted.

1. **Add `preview` enrichment stage producing 1280 px JPEG cache**
2. **Define `VisionDoc` + `VisionMeta` schema types**
3. **Author structured-JSON describe prompt, bump `DESCRIBE_PROMPT_VERSION` to 2**
4. **Strict JSON parser + dead-letter capture for malformed model output**
5. **Swap describe handler to qwen2.5-vl:7b + preview input, bump stage `targetVersion`**
6. **Source `ocr_text` / `ocr_meta` from `vision.text_visible`; widen `ocr_meta.engine` union**
7. **Web inspector chips for `vision.*` fields**
8. **Web browse facets on `vision.scene_type | activity | subjects`**
9. **Docs: update `indexer-enrichment.md` + `sidecar-schema.md`**

(Apple inspector surface, embeddings/vector search, and panorama splitting
are deliberately not in this list. Spec follow-ups when the time comes.)
