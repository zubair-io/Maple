# Info-pane enrichment: description / OCR / transcript

**Date:** 2026-07-24
**Status:** Approved

## Problem

Maple already produces three kinds of AI-derived, per-asset data via background
worker stages, all stored in MongoDB (never in XMP sidecars):

- **Descriptions** — `describe` stage (qwen3-vl via Ollama) → `description`, `vision`.
- **OCR text** — a byproduct of the same vision pass → `ocr_text`, `ocr_meta`.
- **Transcripts** — `transcribe` stage (whisper.cpp on video/audio) → `transcript`
  (`TranscriptDoc`).

Current surfacing is uneven:

| Data        | In `GET /api/assets/:id` DTO? | Shown on Web             | Shown on Apple |
| ----------- | ----------------------------- | ------------------------ | -------------- |
| Description | yes                           | yes (`info-description`) | no             |
| OCR text    | yes                           | yes (`info-vision`)      | no             |
| Transcript  | **no**                        | no                       | no             |

So: transcripts are searchable but never displayed anywhere, and the Apple info
pane surfaces none of the three (EXIF/GPS/rating/histogram/keywords only).

## Goal

Surface description, OCR, and transcript in the info panes on both platforms.

- **Web** gap: transcript only (description + OCR already shown). But the API must
  first expose `transcript` in the detail DTO.
- **Apple** gap: all three, plus first-time enrichment-fetch wiring.

## Scope guard (YAGNI)

Apple receives only the three requested data types — description, OCR text, and
transcript. It does **not** get the full web enrichment surface (structured vision
chips, faces, place). Those remain web-only and can be follow-ups if wanted.

## Design

### 1. Backend (`src/api`) — expose transcript in the detail DTO

`transcript` is stored on the asset but dropped at the DTO boundary. Add a lean
projection to `AssetDetailDto` and `toDetailDto` in
`src/api/src/db/assets.transform.ts`:

```ts
transcript?: {
  text: string;
  language: string | null;
  model: string | null;
  duration_sec: number | null;
  generated_at: string;
} | null;
```

Plain-text display does not need `segments[]`, so they are omitted (YAGNI).
Description + OCR are already in this DTO — no change there.

### 2. Web (`src/web`) — transcript section

- Add the `transcript` field to the `ApiAssetDetail` DTO type in
  `bun-api-backend.service.ts`.
- New standalone `info-transcript` component (signals, separate `.ts`/`.html`/
  `.scss`), rendering `transcript.text` as a plain scrollable block with a
  `language · model` footer — mirroring how `info-vision` renders OCR text.
- Slot it into `info-enrichment.component.html` so it inherits the existing
  Self-Hosted gate. Hidden entirely when there is no transcript.
- Description + OCR already display and are untouched.

### 3. Apple (`src/apple`) — description + OCR + transcript sections

- New `CloudAssetDetailClient` actor in
  `Packages/MapleCore/Sources/MapleCloudKit/Cloud/`, modeled verbatim on
  `CloudHistogramClient`: `init(server:httpClient:)`, `detail(assetID:) async
throws -> CloudAssetDetail`, calling `GET /api/assets/:id` and decoding a new
  `CloudAssetDetail { description, ocr_text, ocr_meta, transcript }` Decodable.
- New `cloudAssetDetailClient` `EnvironmentKey`/`EnvironmentValues` slot mirroring
  `CloudHistogramClientKey`: constructed in `prepareCloudSession`
  (`AppShell+CloudActions.swift`) alongside the histogram client, stored as
  `@State` in `AppShell`, injected in the environment, and cleared to `nil` when
  leaving cloud context — same lifecycle as the histogram client.
- New InfoPanel block(s) under `Maple/Views/InfoPanel/` rendering description, OCR
  text, and transcript as plain-text sections, keyed on `session.asset.stableID`
  via `.task(id:)`, appended after the existing sections in `InfoPanelView`. Each
  section hides when its data is absent. Self-Hosted-only, disambiguated by the
  injected client being non-nil (the established `HistogramBlock` pattern).

## Testing

- **API:** `toDetailDto` unit test asserting transcript passthrough (present and
  null cases), round-tripped against a real inserted asset doc (no mocks).
- **Web:** component spec for `info-transcript` (renders text, hides when absent,
  footer formatting).
- **Apple:** `swift test` covering the `CloudAssetDetail` decode and a pure VM
  projection for the new section. No color/parity harness applies — this is
  UI-only and touches no pixel pipeline.

## Non-goals

- No segment-level / timestamped transcript UI, no seek-on-tap.
- No new worker stages; all three data producers already exist.
- No Apple structured-vision / faces / place surface.
- No XMP involvement — derived data stays in Mongo.
