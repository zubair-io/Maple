# Derivative-Reconcile Worker — Design

**Date:** 2026-07-22
**Branch:** `feature/discover-audit-preview-cloudflare-6460b9`
**Status:** Approved design — pending implementation plan

## Problem

The `discover` sweeper (`src/api/src/workers/discover/sweeper.ts`) only reconciles **paths and existence**. It notices new files and vanished files, but does no work for a recorded file that is still on disk, and it never inspects derivatives. It deliberately skips `.maple/` directories.

Pipeline stages (`thumb`, `preview`, `describe`, `cf-thumb-sync`) each track completion per asset as `stages.<name>.version`. A stage's claim query selects only assets whose `version < targetVersion`, so once a stage marks an asset done it is never revisited.

This produces an unhandled failure mode. When an original is **moved**, `discover` records the new path (a `renamed` event) but keeps `maple_id` and keeps every `stages.*.version` at "done." The derivative-path helpers then compute a `.maple/thumbs/<id>.avif` (and `.maple/previews/<name>.avif`) path under the *new* folder, where nothing exists — while the stage version still says "done," so the claim query never re-selects the asset and nothing regenerates. The stale derivatives under the old folder are cleaned up by the reaper / cache-gc, but nothing recreates them at the new location. The same move can leave a description empty: if the move broke the preview, `describe` ran, saw no preview, skipped with `{ skip: 'preview-missing' }`, and marked itself done with no `description`.

The result: moved files show blank thumbnails/previews, may lack a description, and the thumbnail is not present in Cloudflare R2 at the new path-based key — with no mechanism to self-correct.

## Goal

A background worker that continuously verifies each live asset's derivatives against disk (and Cloudflare R2) and, on drift, re-arms the responsible stage so the existing pipeline regenerates the derivative. The worker **detects and re-arms only** — it never renders, encodes, or uploads derivative bytes itself.

## Non-goals

- No new upload stage. Cloudflare means the **existing** thumb→R2 sync (`cf-thumb-sync`). Previews are verified on local disk only; previews are never uploaded to R2.
- No operator-triggered audit/apply UI. The worker self-heals continuously in the background (an operator-run audit report was considered and declined).
- No deep byte-level validation of derivatives (decoding every AVIF each pass is too costly at scale). "Correct" means *exists and is non-zero size*.

## Core mechanism: the 5-field stage reset

A stage re-runs for an asset when its state is reset to the canonical five-field form. Stage handlers may **not** write `stages.*` in their returned patch (`run-stage.ts` throws on any patch key beginning with `stages.`), so the reconciler issues the reset as a separate targeted `updateOne`, exactly as existing cross-stage resets do (`reArmCacheStages` in `dedupe.helpers.ts`, `rearm-video-posters.ts`, `sidecar-metadata-index.ts`).

```js
{
  'stages.<name>.version': 0,
  'stages.<name>.attempts': 0,
  'stages.<name>.last_error': null,
  'stages.<name>.processed_at': null,
  'stages.<name>.dead': false,
}
```

All five fields are required: a dead-lettered asset (`dead: true`) is excluded from the claim query, so resetting `version` alone would not re-queue it, and a stale `last_error` would keep surfacing in Settings → Workers.

## Shape and placement

The worker follows the `mirror/scan.ts` interval-loop pattern, not a pipeline stage — a stage marks an asset done and never revisits, whereas the auditor's entire purpose is to re-check assets that already report "done."

**Name:** the worker is named **`derivative-audit`** (directory `src/api/src/workers/derivative-audit/`, routes `/api/derivative-audit/*`). It is deliberately *not* called "reconcile" — the codebase already has a **mirror-reconcile** runner (`routes/mirror-reconcile-runner.ts`, `POST /api/mirror/reconcile`) for backup-disk replication, and a second "reconcile" on Settings → Workers would confuse operators.

New directory `src/api/src/workers/derivative-audit/`:

- `scan.ts` — the interval loop (`startDerivativeAudit`), the single-pass driver (`runDerivativeAuditOnce`), per-pass cap, original-present guard.
- `checks.ts` — the four drift predicates + skip-predicate guards.
- `reset.ts` — the generalized 5-field stage reset + per-asset cooldown bookkeeping.
- `progress.ts` — in-process last-pass summary for the status route.

Booted from `workers/maintenance.ts` beside `startMirrorScan` (that is where the other library-wide interval jobs — trash-gc, missing-reaper, dedupe, mirror-scan — are started/stopped), via a `startDerivativeAudit()` export.

## The four checks

Each check acts **only when the stage claims done** (`version >= targetVersion`) yet the output is missing — precisely the state the claim query cannot self-correct. Each check also passes the loop-protection guards (below) before issuing a reset.

| Check | Drift signal | Reset | Cascade |
| --- | --- | --- | --- |
| Thumb | `resolveThumbPathForAsset(asset)` absent or 0 bytes | `thumb` | `thumb` success auto-resets `cf-thumb-sync`, which re-uploads |
| Preview | `cachePathForAsset(asset, 'previews')` absent or 0 bytes | `preview` | — |
| Description | `describe.version >= 7` **and** `description` empty/absent **and** a preview exists on disk | `describe` | — |
| R2 (deep) | `thumbExistsInR2(key)` HEAD returns 404, local thumb present, asset **not hidden** | `cf-thumb-sync` | re-upload at the current path-based key |

The description is a database field, so it survives a move; it goes "missing" only via the `describe` skip path. Guarding on "a preview now exists on disk" ensures that resetting `describe` actually produces a description on the re-run rather than skipping again.

## Loop protection

Several stages legitimately mark themselves done **without** writing a file: `thumb` and `preview` skip `stub-file`, `no-video-decoder`, and `no-resolvable-location`; `describe` skips `preview-missing`; `cf-thumb-sync` *deletes* the R2 object and clears `cf_thumb_synced_at` for **hidden** assets. If the reconciler reset one of these, the stage would re-run, skip again, mark done, and be reset again — an infinite loop that floods the pipeline. Two layers prevent this:

1. **Replicate each stage's cheap skip predicates** before resetting: skip stub-files and unresolvable locations for thumb/preview, skip hidden assets for the R2 check, and skip cases where the derivative legitimately cannot exist (e.g. video with no decoder).
2. **Bounded per-asset, per-check cooldown.** A small `reconcile.<check>` subdoc records `last_reset_at` and `attempts`. An asset+check is not reset again within a cooldown window or beyond N attempts. This backstops any imperfect predicate: a reset that does not "take" stops retrying and is optionally flagged for the operator instead of thrashing.

## Deep R2 verification

Add `thumbExistsInR2(config, key): Promise<boolean>` to `src/api/src/cloudflare/r2-client.ts` (a `headObject`/HEAD against the bucket). Because this is a network round-trip per asset, the R2 check runs under **bounded concurrency** with a per-pass cap, and is skipped entirely when R2 credentials are absent (the same config gate `cf-thumb-sync` uses) so it never mass-resets on an unconfigured deploy.

## Configuration and operator surface

Per the settings-not-env-vars convention, configuration lives in `worker_config` settings and is surfaced on **Settings → Workers** as a reconcile row:

- `enabled` — master toggle.
- `scan_interval` — loop cadence.
- `max_resets_per_pass` — runaway cap.
- `deep_r2_enabled` — toggle for the network R2 check (auto-disabled when R2 is unconfigured regardless of this flag).

The row displays last-pass time and resets issued per category, with pause/resume — the same affordances mirror-scan and the stages already expose.

## Safety guards

Mirrored from `mirror/scan.ts`:

- **Live assets only** (`liveFileInfoElemMatch`); skip `damaged`.
- **Per-pass reset cap** (`max_resets_per_pass`) — never re-arm the whole library in a single pass, protecting the downstream pipeline from a flood.
- **Root-offline mount guard** for the disk checks, so an unmounted library volume reads as "not present" rather than "every file vanished, reset everything."

## Testing

Integration tests against a real throwaway MongoDB and temporary directories (no sidecar mocks — XMP/derivatives are the contract):

- **Move fixture:** relocate an original, run a pass, assert the correct stage(s) reset and the others do not.
- **Skip-legit fixtures:** stub-file, hidden, and video-without-decoder assets assert **no** reset (the loop guard holds).
- **Cooldown:** a second consecutive pass does not re-reset an asset whose first reset did not "take."
- **R2 check:** exercised against a faked `thumbExistsInR2` returning present/absent.

## Ticket

Open a KTLO issue ("Derivative-reconcile worker: self-heal thumb/preview/description/R2 drift after moves") and add it to the KTLO board before implementation. The PR closes it via `Closes #N`.
