/**
 * Discover producer — a breadth-first reconciliation sweep, one directory at a
 * time, in place of the retired chokidar polling watcher. It runs on Temporal:
 * one workflow per library root sweeps it in bounded slices (see
 * `discover-lane.ts`).
 *
 * Discover is NOT a stage controller — it does not use `defineStage` or
 * `runStage`. It owns only the insert side: on a new or modified file it
 * upserts the image doc with the skeleton, and the exif/thumb stages pick it
 * up on their next slice. On remove it soft-deletes (sets
 * deleted_at) via handleEvent.
 *
 * Layout (split per #253, refs #134):
 *   - `types.ts`               — `WatchEvent`, `SUPPORTED_EXTS`, and the pure
 *                                path-normalisation helpers.
 *   - `handle-event.ts`        — `handleEvent`, the per-event dedup/insert core.
 *   - `frontier.repo.ts`       — the frontier queue (claim/complete/enqueue).
 *   - `sweeper.ts`             — `visitDirectory`, `advanceSweep`.
 *   - `sweep-slice.ts`         — `runSweepSlice`, one bounded stretch of a root's sweep.
 *   - `discover-workflow.ts`   — the per-root workflow (Temporal sandbox code).
 *   - `discover-activity.ts`   — the `sweepRoot` activity, single-flight per root.
 *   - `discover-lane.ts`       — the Temporal lane that keeps a workflow per root.
 *   - `discover-config.repo.ts`— read/write `discover` row in `worker_config`.
 *   - `index.ts` (here)        — the public re-exports.
 */

// External consumers (`routes/folders.ts`, `fs/browse.ts`, the test suite)
// import this from `./index.ts` and must stay stable across the split.
export { handleEvent } from './handle-event.ts';
