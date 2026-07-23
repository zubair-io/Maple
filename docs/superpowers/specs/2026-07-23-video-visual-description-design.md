# Multi-frame Video Visual Description — Design

**Date:** 2026-07-23

**Ticket:** #2158

**Status:** Draft design; provider-boundary implementation started

## Problem and product contract

Maple describes a video from its poster frame today, so later subjects, actions, text, and scene
changes are invisible to search. For each live video, Maple should derive:

- a short summary of the whole clip;
- an ordered scene list with approximate timestamps, captions, and visible text.

The result is derived MongoDB data, never XMP. Audio/transcription, raw-video model input, and
independent per-frame caption calls are out of scope.

## Architecture

Add a separate `video-describe` stage after `preview`. This preserves the existing cheap
poster-frame `describe` result, gives heavy GPU work independent pause/concurrency/retry controls,
and avoids changing the still-image prompt and parser.

`DescribeProvider.describe` accepts an ordered `readonly Buffer[]`. All providers serialize those
frames into one request; the still stage passes a one-element array. Empty lists are caller errors.
The sampling stage, not providers, owns the product cap.

## Bounded frame sampling

Defaults are code constants until hardware measurements justify operator settings:

| Bound                                      |                     Default |
| ------------------------------------------ | --------------------------: |
| Frames sent                                |                           6 |
| Absolute frame cap                         |                           8 |
| I-frame candidates inspected               |                          64 |
| Difference thumbnail                       |                   64×64 RGB |
| Normalized mean pixel-difference threshold |                        0.12 |
| Model frame encoding                       | max 768 px, JPEG quality 82 |
| Total encoded images                       |                       8 MiB |
| ffmpeg wall-clock budget                   |                  30 seconds |

The sampler probes duration and ordered I-frame timestamps, retains the first and last useful
candidate, and compares each candidate with the last retained 64×64 image. Candidates at or above
the difference threshold survive. More than six survivors are uniformly downselected while
retaining endpoints. Fewer than two survivors on a non-trivial clip are filled from uniform
duration anchors and deduplicated again. A one-frame result remains valid for static or very short
clips.

This combines cheap codec-selected candidates with deterministic visual deduplication. Uniform
fill prevents a long single take from being represented only by its opening.

## Cost and degradation

- The stage starts paused with concurrency one.
- One asset normally makes one request with six or fewer frames; eight is a hard cap.
- Spend reservation reuses the existing repository and estimates by frame count.
- A provider multi-image rejection retries with every other selected frame, then poster-only.
  Transport errors use ordinary stage backoff rather than immediate inference retries.
- Missing ffmpeg, no stream, timeout, or no decodable frame is a terminal skip.
- Metadata records candidate/chosen counts, encoded bytes, sampling/inference time, fallback level,
  provider/model/prompt version, generation time, and cost.
- Default enablement requires an RTX 4000 acceptance run showing stable memory and no starvation of
  the still `describe` queue.

## Prompt, schema, and trustworthy timestamps

The prompt says that images are chronological samples from one video and that missing intervals
must not be invented. Constrained output is:

```json
{
  "summary": "string",
  "scenes": [{ "frame_index": 0, "caption": "string", "text_visible": "string or null" }]
}
```

The model returns frame indexes, not timestamps. The stage validates unique in-range indexes and
maps them to sampler-owned timestamps, preventing fabricated times.

## Storage and search

```ts
video_description: {
  summary: string;
  scenes: Array<{
    timestamp_ms: number;
    caption: string;
    text_visible: string | null;
  }>;
}
```

`video_description_meta` stores generation and cost diagnostics. `composeSearchBlob` adds the
summary once, then each unique scene caption and visible-text value once. Existing `description`
and `vision` remain the poster-frame result.

## Sequencing correction

The transcribe stage is present, but the issue's referenced design document and shared duration
helper are absent from this branch; transcribe currently derives duration from extracted PCM. The
new duration/sampling API will therefore live in a neutral video module. Transcribe can adopt the
probe separately; it is not a prerequisite.

## Acceptance

- All four providers send ordered frames in one request; still description remains unchanged.
- Static, hard-cut, long single-take, sub-second, rotated, and malformed fixtures stay within every
  count/byte/time bound.
- Multi-image rejection degrades to fewer frames and poster-only.
- Non-video assets are never claimed; originals and XMP are never written.
- Search finds a term present only in a later scene.
- RTX 4000 throughput and peak-memory results are recorded before default enablement.
