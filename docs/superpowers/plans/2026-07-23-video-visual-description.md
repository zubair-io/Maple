# Multi-frame Video Visual Description — Implementation Plan

**Goal:** Build #2158 as a bounded `video-describe` stage that understands materially different
moments through one coherent vision request.

## Tasks

- [x] **Multi-image provider boundary**
  - Change `DescribeProvider.describe` to ordered `readonly Buffer[]`.
  - Serialize all frames for Ollama, Anthropic, OpenAI, and Gemini.
  - Reject empty lists; keep still behavior through a one-element array.
  - Add request-shape tests.

- [ ] **Duration and keyframe probe**
  - Add a neutral video probe returning duration and capped ordered I-frame timestamps.
  - Reuse runnable-binary discovery and process timeout conventions.
  - Test malformed input, short clips, missing ffmpeg, and candidate caps.

- [ ] **Deterministic selector**
  - Extract 64×64 candidates, compare normalized mean RGB difference, retain endpoints, uniformly
    downselect, and fill from duration anchors.
  - Enforce frame, dimension, byte, and wall-clock bounds.

- [ ] **Prompt and parser**
  - Add a versioned chronological-video prompt and JSON schema.
  - Validate unique frame indexes and map them to sampler timestamps.

- [ ] **`video-describe` stage**
  - Claim videos only, sample the live original, reserve spend, make one normal-path request, and
    persist the structured result and diagnostics.
  - Add reduced-frame and poster-only fallback.
  - Register after `preview`, paused on first boot, concurrency one.

- [ ] **Search and projections**
  - Add unique summaries, captions, and visible text to `search_blob`.
  - Expose the structured result through existing asset DTOs.
  - Test search for content found only after the poster.

- [ ] **Operator rollout**
  - Surface the stage in Settings → Workers.
  - Record sampler/inference timing and frame/byte/fallback metrics.
  - Measure representative clips on RTX 4000 before changing the default pause state.

## Verification

Use focused Bun tests during each task, then the API suite and the repository's pinned
changed-file Prettier gate. ffmpeg integration tests explicitly skip when no runnable binary is
available.
