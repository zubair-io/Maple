// Info-panel enrichment — pure view-model module.
//
// Co-located with the enrichment sub-components per the `*.vm.ts` pattern
// adopted in #190 (this file replaces the old `detail-panel/info-tab.vm.ts`
// dropped in #634 when `<maple-info-tab>` was folded into `<app-info-panel>`).
//
// Everything in here is plain TypeScript: no `@angular/*` imports, no
// `inject()`, no decorators, no signals. The orchestrator + leaf components
// own DI, signal wiring, and side effects; this module owns the formatting
// and derivation math the templates read through helper methods.

import type {
  ApiAssetDetail,
  ApiEnrichmentStage,
  ApiEnrichmentStageState,
  ApiPlace,
} from '../api/bun-api-backend.service';
import type { MuiEnrichmentStageStatus } from '../ui/enrichment-panel/mui-enrichment-panel.component';

// ── Constants ──────────────────────────────────────────────────────────────

/** How long the post-requeue refresh poll runs before giving up. */
export const REFRESH_TIMEOUT_MS = 30_000;
/** Poll interval inside the refresh window. */
export const REFRESH_POLL_MS = 2_000;

/** Deep link for "Worker paused" badges and stale-after-requeue hints.
 * The workers admin page already exists at this route. */
export const WORKERS_SETTINGS_URL = '/settings/workers';

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

export function formatRollups(rollups: { locality: string | null; region: string | null }): string {
  const parts = [rollups.locality, rollups.region].filter((v): v is string => !!v);
  if (parts.length === 0) return '(no rollup)';
  return parts.join(', ');
}

export function taggedFaces(d: ApiAssetDetail): { person_id: string }[] {
  return d.faces.filter((f) => f.person_id !== null).map((f) => ({ person_id: f.person_id! }));
}

export function untaggedFaceCount(d: ApiAssetDetail): number {
  return d.faces.filter((f) => f.person_id === null).length;
}

/** Synthesize the full `ApiPlace` the override endpoint expects from a
 * single manually-typed display name — `<mui-place-row>` only round-trips
 * that one string, so every other field is carried over from the asset's
 * existing place (or a sensible empty default when there wasn't one).
 * `text` empty/whitespace-only clears the override (`null`). */
export function buildManualPlaceOverride(text: string, existing: ApiPlace | null): ApiPlace | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return {
    source: 'manual',
    geocoder_version: 0,
    geocoded_at: new Date().toISOString(),
    lat: existing?.lat ?? 0,
    lon: existing?.lon ?? 0,
    display_name: trimmed,
    address: existing?.address ?? {},
    pois: existing?.pois ?? [],
    rollups: existing?.rollups ?? { locality: null, region: null, country_code: null },
    search_blob: trimmed.toLowerCase(),
  };
}

/** True when something in the enrichment subdoc moved between the two
 * snapshots — a worker run flipped `done_at`, bumped `version`, cleared an
 * error, etc. Used by the post-requeue poll loop to decide when to stop. */
export function detailChanged(a: ApiAssetDetail | null, b: ApiAssetDetail | null): boolean {
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
 * `workerPaused()` in the orchestrator) and `now` (from `Date.now()`), and
 * passes both in so this function has no observable side effects. */
export function stageStatus(
  s: ApiEnrichmentStageState,
  paused: boolean,
  now: number = Date.now(),
): MuiEnrichmentStageStatus {
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
