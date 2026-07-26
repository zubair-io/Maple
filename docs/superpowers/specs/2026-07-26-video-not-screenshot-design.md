# Videos Are Never Screenshots — Design

**Date:** 2026-07-26

**Ticket:** #2325

**Status:** Approved design

## Problem

A video asset can end up with `is_screenshot: true`. Two things go wrong when it does. The video
drops out of the Photos bucket of the tri-state Photos/Screenshots filter, so it becomes hard to
find. And because prompt v5 short-circuits every scene field when the model classifies an image as a
screenshot, the video also loses `scene_type`, `setting`, `activity`, `time_of_day`, `lighting`,
`weather`, `composition`, and `shot_type` — its description collapses to a caption and whatever
on-screen text was transcribed.

There are five write sites, spread across the ingest route, two worker stages, and a file-move side
effect.

The first is the EXIF stage at `workers/stages/exif.ts:118`, which seeds the flag from
`isLikelyScreenshot(path, camera_make)`. That helper is documented as conservative because it only
fires when `camera_make` is empty, but that guard is dead code for video: every video container sits
in `NO_EXIF_EXTS`, so exifr never returns a make and the branch never protects anything. The
filename regex is the only thing standing between a video and the flag.

The second, and the one that actually drives the reports, is the describe stage. Videos are not
excluded from it. The preview stage renders a poster frame through ffmpeg
(`workers/stages/preview.ts:68`), the describe stage finds that preview and ships it to qwen2.5-vl,
and the model returns `is_screenshot: true` for any frame that looks like a user interface. A screen
recording hits this every time.

The third is a side effect of the second. On a positive verdict for a backup-origin asset, the
describe stage calls `relocateBackupScreenshot`, which moves the file on disk into
`<year>/Screenshot`.

The fourth is `workers/stages/sidecar-metadata-index.ts:146`, which recomputes the effective flag
whenever a sidecar is re-indexed. It reads `vision.is_screenshot` back out of the stored subdoc
first, so a bad verdict persists through re-indexing even if the top-level mirror were corrected.

The fifth is the ingest route at `routes/backup-ingest.ts:135`, which files a `Screenshot`-named
upload into `<year>/Screenshot` before any EXIF has been parsed.

## Product contract

`is_screenshot` is a stills-only concept. No video is ever a screenshot, enforced at every write
site. Screen recordings are videos and stay in the normal video bucket; they do not get a separate
classification of their own.

## Scope

Server-side only, in `src/api`.

Apple and Web are read-only consumers. On Apple, `isScreenshot` appears solely as a search-filter
parameter in `SearchParams`, `SearchFilterPanel`, and the two TV view models;
`MapleBackup.PathFormatter` accepts an `isScreenshot` argument but no production Swift caller ever
computes one, so the server owns that decision. On Web the flag is read by the tri-state filter in
the search component and its facet counts. Neither needs a change.

There is no color-pipeline surface here, so the parity harness does not apply.

This complements ticket #2158 (multi-frame `video-describe`), which adds a separate stage and
explicitly preserves the existing poster-frame `describe` result. That work does not touch
`is_screenshot`, and this work does not touch the still-image prompt or parser, so the two do not
collide.

## Architecture

### One video-aware predicate

`indexer/screenshot.ts` gains a video check, and both `isScreenshotFilename` and
`isLikelyScreenshot` return `false` for any filename that `isVideoFilename` matches.

Clamping inside that module rather than at each call site follows the reasoning already written into
its own docstring: it exists so the ingest-time folder decision and the stage-time seed cannot drift
apart. A single edit there corrects the EXIF stage, the sidecar-metadata-index stage, and the ingest
route together.

Note that this makes the extension test the real guard. The `camera_make` condition stays for
still images, where it does useful work, but it should no longer be described as what protects
video.

### Clamping the model verdict

The describe stage computes `isVideo` once from the primary fileinfo entry and forces the flag false
in three places that currently trust `vision.is_screenshot` directly.

The top-level `is_screenshot` mirror in the patch is the visible one. The copy inside the stored
`vision` subdoc matters just as much, because `sidecar-metadata-index` reads that field back as its
first source of truth — leaving it true would let the flag reappear on the next sidecar re-index.
And the `relocateBackupScreenshot` guard has to be included, because otherwise a video keeps being
moved into `<year>/Screenshot` on disk even after the flag itself reads false.

### Sidecar overrides

A user can set `papp:IsScreenshot` on any asset, and `sidecar-metadata-index` gives that override
precedence over the computed value. The override stays in the sidecar untouched, since XMP is the
contract and passthrough preserves what the user wrote. What gets clamped is the derived top-level
`is_screenshot` that search, the facet counts, and the Photos/Screenshots filter actually read. The
invariant holds everywhere it is observable without discarding anything the user authored.

### Migration for already-flagged videos

A new `clear-video-screenshot-flags` migration follows the shape of `rearm-video-posters.ts`,
reusing its `liveVideoFileinfoMatch()` selector and its done-marker pattern.

It selects live-video assets that carry `is_screenshot: true` or `vision.is_screenshot: true` and
sit below the marker version. For each, it sets both fields false, re-arms the `describe` stage so
the nulled scene fields have a chance to regenerate, and resets `meili` so the search index and its
facet counts pick up the corrected value. The done marker is `video_screenshot_clear_version`,
mirroring `video_poster_rearm_version`; without one the candidate set would refill as soon as a
stage re-stamped the asset and the migration would loop.

It registers in `migration/index.ts`, which puts its toggle on Settings → Workers alongside every
other migration. Per the `Migration` contract, `runBatch` must be idempotent and `countRemaining`
must stay a cheap count query rather than a scan.

## Known limitation

Re-running describe on a genuine screen recording will probably null the scene fields again. The
short-circuit lives in the prompt, and the model still sees a user interface in the poster frame.
The flag stays correct either way, which is what the ticket is about, and the re-arm still recovers
videos that were only ever misclassified by the filename heuristic.

Fixing the description quality properly would need a video-specific prompt variant and a
prompt-version bump that re-runs the entire library. That is deliberately out of scope. Ticket #2158
is the better home for it if it turns out to matter.

## Testing

The predicate gets unit coverage for video extensions paired with screenshot-shaped names, across
both exported functions, so a `Screenshot_20240601.mp4` is negative while the existing still-image
cases stay positive.

The describe stage gets a test where the primary fileinfo is a video and the provider returns
`is_screenshot: true`, asserting that the patch writes false, that the stored `vision` subdoc also
carries false, and that the relocation helper is never called.

The ingest route gets a case proving a `Screenshot`-named video does not land in `<year>/Screenshot`
and does not seed the flag, as a counterpart to the existing
`backup-ingest-screenshot.test.ts` coverage for stills.

The sidecar-metadata-index stage gets the override case: a video with an explicit override of true
projects a top-level false while the sidecar value survives.

The migration gets a test modeled on `rearm-video-posters.test.ts`, covering candidate selection,
the field writes, the stage re-arms, and idempotency on a second pass.

Integration tests need a real MongoDB rather than a mock, consistent with how the API suite is set
up.
