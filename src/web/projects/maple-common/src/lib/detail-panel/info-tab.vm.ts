// Info tab — pure view-model module.
//
// Co-located with `info-tab.component.ts` per the `*.vm.ts` pattern adopted
// in #190. Anything in this file is plain TypeScript: no `@angular/*` imports,
// no `inject()`, no decorators, no signals. The component owns DI, signal
// wiring, and side effects; this module owns the formatting and derivation
// math the template reads through `vm().*` (or, for now, through the
// component's helper methods that delegate to these functions).

import type { ColorLabel } from '../models/asset';
import type {
  ApiAssetDetail,
  ApiEnrichmentStage,
  ApiEnrichmentStageState,
} from '../api/bun-api-backend.service';
import type { EnrichmentStageStatus } from './enrichment-status-badge.component';

// ── Constants ──────────────────────────────────────────────────────────────

export const COLOR_LABELS: readonly { name: ColorLabel; hex: string }[] = [
  { name: 'red', hex: '#e74c3c' },
  { name: 'orange', hex: '#e9873f' },
  { name: 'yellow', hex: '#e9b93f' },
  { name: 'green', hex: '#4ade80' },
  { name: 'blue', hex: '#6aa0d4' },
];

export const STAR_INDICES: readonly number[] = [1, 2, 3, 4, 5];

export const HISTORY: readonly { label: string; time: string }[] = [
  { label: 'Original import', time: 'Import' },
  { label: 'Basic tone', time: '3d ago' },
  { label: 'Warm grade', time: '2h ago' },
];

/** How long the post-requeue refresh poll runs before giving up. */
export const REFRESH_TIMEOUT_MS = 30_000;
/** Poll interval inside the refresh window. */
export const REFRESH_POLL_MS = 2_000;

/** Deep link for "Worker paused" badges and stale-after-requeue hints.
 * The workers admin page already exists at this route. */
export const WORKERS_SETTINGS_URL = '/settings/workers';

// ── Filename / size / date formatters ─────────────────────────────────────

export function ext(filename: string): string {
  return filename.split('.').pop() ?? '';
}

export function xmpName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '.xmp');
}

export function formatSize(bytes: number | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// ── Enrichment-payload derivations ────────────────────────────────────────

export function showPlaceSection(d: ApiAssetDetail): boolean {
  // Hide once geocoded as no-place (worker ran, found nothing). The worker
  // writes `place: null` AND sets `done_at` non-null in that case; pending
  // rows have `done_at: null`.
  if (d.place === null && d.enrichment.geocode.done_at !== null) {
    return false;
  }
  return true;
}

export function formatRollups(rollups: {
  locality: string | null;
  region: string | null;
}): string {
  const parts = [rollups.locality, rollups.region].filter(
    (v): v is string => !!v,
  );
  if (parts.length === 0) return '(no rollup)';
  return parts.join(', ');
}

export function taggedFaces(d: ApiAssetDetail): { person_id: string }[] {
  return d.faces
    .filter((f) => f.person_id !== null)
    .map((f) => ({ person_id: f.person_id! }));
}

export function untaggedFaceCount(d: ApiAssetDetail): number {
  return d.faces.filter((f) => f.person_id === null).length;
}

/** True when something in the enrichment subdoc moved between the two
 * snapshots — a worker run flipped `done_at`, bumped `version`, cleared an
 * error, etc. Used by the post-requeue poll loop to decide when to stop. */
export function detailChanged(
  a: ApiAssetDetail | null,
  b: ApiAssetDetail | null,
): boolean {
  if (!a || !b) return true;
  const stages: ApiEnrichmentStage[] = ['geocode', 'face', 'describe'];
  for (const s of stages) {
    const sa = a.enrichment[s];
    const sb = b.enrichment[s];
    if (sa.done_at !== sb.done_at) return true;
    if (sa.version !== sb.version) return true;
    if (sa.dead_letter_at !== sb.dead_letter_at) return true;
  }
  return false;
}

// ── Stage-status / skip-reason labelling ──────────────────────────────────

/** Human label for a `skip: …` reason. Falls back to a generic "Skipped"
 * with the raw reason in the tooltip so we don't lose info for skip cases
 * the workers may add later. */
export function skipReasonLabel(reason: string): string {
  if (reason === 'no-gps') return 'No GPS';
  if (reason === 'image-missing') return 'No thumbnail';
  if (reason.startsWith('thumb-missing')) return 'No thumbnail';
  if (reason.startsWith('thumb-undecodable')) return 'Thumbnail unreadable';
  return 'Skipped';
}

/** Decide what badge to show for a stage row.
 *
 * The DTO carries enough fields to pin down every state — we layer the
 * worker-pause cache on top so a paused-on-first-boot stage reads as
 * "Worker paused" instead of an indefinite "Pending". Priority order
 * matches the table in the plan: failed > skipped > complete > paused >
 * running > pending.
 *
 * Pure: the caller resolves the per-stage paused boolean (from
 * `workerPaused()` in the component) and `now` (from `Date.now()`), and
 * passes both in so this function has no observable side effects. */
export function stageStatus(
  s: ApiEnrichmentStageState,
  paused: boolean,
  now: number = Date.now(),
): EnrichmentStageStatus {
  if (s.dead_letter_at) {
    return {
      kind: 'failed',
      label: 'Failed',
      tooltip: s.last_error ?? undefined,
    };
  }
  // A "skip: …" last_error means the worker decided not to process the
  // asset — done_at is also set in that case (the supervisor stamps both
  // fields in the skip path).
  if (s.last_error?.startsWith('skip: ')) {
    const reason = s.last_error.slice('skip: '.length);
    return {
      kind: 'skipped',
      label: skipReasonLabel(reason),
      tooltip: s.last_error,
    };
  }
  if (s.done_at !== null) {
    // Complete — no badge needed.
    return { kind: 'complete', label: '' };
  }
  if (paused) {
    return { kind: 'paused', label: 'Worker paused' };
  }
  // Treat a live lease as "Running…"; otherwise the row is queued for the
  // next supervisor tick.
  if (s.locked_by && s.lease_expires_at) {
    const expires = Date.parse(s.lease_expires_at);
    if (Number.isFinite(expires) && expires > now) {
      return { kind: 'running', label: 'Running…' };
    }
  }
  return { kind: 'pending', label: 'Pending' };
}

// ── ViewModel shape ───────────────────────────────────────────────────────

/** Shape of the data the template ultimately needs. Reserved for the
 * follow-up slice that builds a `vm = computed(...)` in the component;
 * exporting the type now so consumers (and tests) can lean on it. */
export interface InfoTabAssetVM {
  ext: string;
  xmpName: string;
  size: string;
  capturedAt: string;
  mtime: string;
}
