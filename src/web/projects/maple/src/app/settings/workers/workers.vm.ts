// Workers tab — pure view-model module.
//
// Co-located with `workers.component.ts` per the `*.vm.ts` pattern adopted
// in #190 (slice 1: info-tab, #218). Anything in this file is plain
// TypeScript: no `@angular/*` imports, no `inject()`, no decorators, no
// signals. The component owns DI, signal wiring, and side effects; this
// module owns the formatting, classification, and derivation math.
//
// All Angular-bearing types are imported via `import type` so this module
// can compile/be tested as plain TS.

import type { EnrichmentConfigResponse, StageStatus, WorkerConfig } from '@maple-common';
import { STAGE_META, type StageGroup } from './workers-stage-meta';
export { STAGE_META, stageMeta } from './workers-stage-meta';
export type { StageGroup, StageMeta, EnrichmentKind } from './workers-stage-meta';

// ── Polling cadence ────────────────────────────────────────────────────────

export const POLL_MS = 2_000;
export const ERROR_POLL_MS = 5_000;

// ── Stage metadata ────────────────────────────────────────────────────────

const WHISPER_MODEL_TIERS = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3'] as const;
export type WhisperModelTier = (typeof WHISPER_MODEL_TIERS)[number];

export function isWhisperModelTier(value: string): value is WhisperModelTier {
  return (WHISPER_MODEL_TIERS as readonly string[]).includes(value);
}

// ── Per-stage form shapes ─────────────────────────────────────────────────

/** Per-stage form state for the runtime knobs in the expanded panel.
 * Lazily populated when a row is first expanded so unsaved values
 * survive a poll without flickering. */
export interface RuntimeForm {
  concurrency: string;
  maxAttempts: string;
  version?: string;
  prompt_text?: string;
}

/** Per-stage form state for non-AI enrichment controls. */
export interface EnrichmentForm {
  transcribe_model_tier: string;
  // Geocode
  nominatim_url: string;
  nominatim_rate_limit_per_sec: string;
  // Face — detector config lives on the face-detect row, recognizer config
  // on the face-embed row; the model dir is shared (face-detect owns it).
  face_model_dir: string;
  face_detector_url: string;
  face_detector_sha256: string;
  face_recognizer_url: string;
  face_recognizer_sha256: string;
  /** Minimum face size as a string for the input element (normalised [0,1)). */
  face_min_detection_size: string;
  // Meili (search index)
  meilisearch_url: string;
  // Write-only: always starts blank (the saved key is never echoed). A
  // blank value on save means "leave the saved key unchanged".
  meilisearch_api_key: string;
  meilisearch_task_timeout_seconds: string;
  meilisearch_semantic_enabled: boolean;
  meilisearch_semantic_ratio: string;
  service_search_rate_limit_per_minute: string;
}

export type SaveState = 'idle' | 'saving' | 'success' | 'error';

// Single source of truth for runtime-form defaults. Used by both
// `blankRuntime()` (used when a per-field write happens before the row's
// form was seeded) and `saveStagePatch()` (the bounded clamp inputs).
// Keep these in sync with the min/max hints in the template — server-side
// validation is still authoritative.
export const DEFAULT_RUNTIME = Object.freeze({
  concurrency: 2,
  maxAttempts: 5,
});

/** Concurrency clamp ceiling. Raised 32 → 100 in #674 (pure guardrail); the
 * server enforces the same bound. */
export const CONCURRENCY_MAX = 100;

/** Seed form values from a stage's persisted config, falling back to
 * `DEFAULT_RUNTIME` per field. */
export function blankRuntime(stage: StageStatus): RuntimeForm {
  const cfg = stage.config;
  return {
    concurrency: String(cfg?.concurrency ?? DEFAULT_RUNTIME.concurrency),
    maxAttempts: String(cfg?.maxAttempts ?? DEFAULT_RUNTIME.maxAttempts),
    version: cfg?.version ?? 'v0.1.0',
    prompt_text: cfg?.prompt_text ?? '',
  };
}

/** Face slice of the seed. Grouped like the Meilisearch slice below so
 * `blankEnrichment` stays a readable assembly of per-domain groups rather
 * than one long fallback chain. */
function blankFace(ec: EnrichmentConfigResponse | null) {
  // `text` keeps the null-coalescing in one place: a per-field `?? ''`
  // chain reads fine but scores as one branch each, and this block is all
  // the same rule — an unset field is an empty input.
  const text = (value: string | null | undefined): string => value ?? '';
  return {
    face_model_dir: text(ec?.face_model_dir),
    face_detector_url: text(ec?.face_detector_url),
    face_detector_sha256: text(ec?.face_detector_sha256),
    face_recognizer_url: text(ec?.face_recognizer_url),
    face_recognizer_sha256: text(ec?.face_recognizer_sha256),
    face_min_detection_size: String(ec?.face_min_detection_size ?? 0.06),
  };
}

function blankMeilisearchSemantic(ec: EnrichmentConfigResponse | null) {
  return {
    meilisearch_semantic_enabled: ec?.meilisearch_semantic_enabled ?? false,
    meilisearch_semantic_ratio: String(ec?.meilisearch_semantic_ratio ?? 0.5),
  };
}

/** Seed the worker controls; AI assignments live on the AI page. */
export function blankEnrichment(ec: EnrichmentConfigResponse | null): EnrichmentForm {
  return {
    transcribe_model_tier: ec?.transcribe_model_tier ?? 'medium.en',
    nominatim_url: ec?.nominatim_url ?? '',
    nominatim_rate_limit_per_sec: String(ec?.nominatim_rate_limit_per_sec ?? 10),
    ...blankFace(ec),
    meilisearch_url: ec?.meilisearch_url ?? '',
    // Never seeded from the response — the key is write-only.
    meilisearch_api_key: '',
    meilisearch_task_timeout_seconds: String(ec?.meilisearch_task_timeout_seconds ?? 600),
    ...blankMeilisearchSemantic(ec),
    service_search_rate_limit_per_minute: String(ec?.service_search_rate_limit_per_minute ?? 60),
  };
}

export function meilisearchFormToPatch(form: EnrichmentForm) {
  const key = form.meilisearch_api_key.trim();
  const taskTimeout = Number(form.meilisearch_task_timeout_seconds.trim());
  const semanticRatioText = form.meilisearch_semantic_ratio.trim();
  const semanticRatio = semanticRatioText === '' ? Number.NaN : Number(semanticRatioText);
  const serviceRate = Number(form.service_search_rate_limit_per_minute.trim());
  return {
    meilisearch_url: form.meilisearch_url.trim() || null,
    ...(key.length > 0 ? { meilisearch_api_key: key } : {}),
    meilisearch_task_timeout_seconds:
      Number.isInteger(taskTimeout) && taskTimeout >= 30 && taskTimeout <= 3600
        ? taskTimeout
        : null,
    meilisearch_semantic_enabled: form.meilisearch_semantic_enabled,
    meilisearch_semantic_ratio:
      Number.isFinite(semanticRatio) && semanticRatio >= 0 && semanticRatio <= 1
        ? semanticRatio
        : null,
    service_search_rate_limit_per_minute:
      Number.isInteger(serviceRate) && serviceRate > 0 ? serviceRate : null,
  };
}

// ── Parsing / clamping ────────────────────────────────────────────────────

/** Parse a string as an int, clamp to [min, max], or return `fallback`
 * when the string is not finite. Server-side validation is authoritative;
 * this just keeps the round-trip body sane. */
export function parseClampedInt(value: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Turn a runtime form into a `Partial<WorkerConfig>` patch, with each
 * field clamped to the per-knob acceptable range. */
export function runtimeFormToPatch(form: RuntimeForm): Partial<WorkerConfig> {
  return {
    concurrency: parseClampedInt(form.concurrency, 1, CONCURRENCY_MAX, DEFAULT_RUNTIME.concurrency),
    maxAttempts: parseClampedInt(form.maxAttempts, 1, 20, DEFAULT_RUNTIME.maxAttempts),
    ...(form.version !== undefined ? { version: form.version.trim() || null } : {}),
    ...(form.prompt_text !== undefined ? { prompt_text: form.prompt_text.trim() || null } : {}),
  };
}

// ── Grouping / summary ────────────────────────────────────────────────────

/** Stages bucketed + ordered as pipeline groups (Ingest → Enrich → Index).
 * Stages we don't know about land in Ingest at the end. */
export function groupStagesByPipeline(
  stages: readonly StageStatus[],
): readonly { group: StageGroup; rows: StageStatus[] }[] {
  const order: StageGroup[] = ['Ingest', 'Enrich', 'Index'];
  const groups: Record<StageGroup, StageStatus[]> = { Ingest: [], Enrich: [], Index: [] };
  for (const s of stages) {
    const g = STAGE_META[s.name]?.group ?? 'Ingest';
    groups[g].push(s);
  }
  return order.map((g) => ({ group: g, rows: groups[g] }));
}

/** Aggregate counters across all stages — the header tile in the
 * Workers settings page reads from this. */
export function summarizeStages(stages: readonly StageStatus[]): {
  running: number;
  idle: number;
  paused: number;
  dead: number;
  pending: number;
} {
  return {
    running: stages.filter((s) => s.status === 'running').length,
    idle: stages.filter((s) => s.status === 'idle').length,
    paused: stages.filter((s) => s.status === 'paused').length,
    dead: stages.reduce((acc, s) => acc + s.dead, 0),
    pending: stages.reduce((acc, s) => acc + s.pending, 0),
  };
}

/** Bump minor version of semver string (e.g. "v0.2.1" -> "v0.3.0"). */
export function bumpMinorVersion(version: string | null | undefined): string {
  const clean = (version ?? 'v0.1.0').trim();
  const hasV = clean.startsWith('v') || clean.startsWith('V');
  const numStr = hasV ? clean.slice(1) : clean;
  const parts = numStr.split('.').map((p) => Number.parseInt(p, 10));
  const major = Number.isFinite(parts[0]) ? parts[0]! : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1]! : 1;
  const nextMinor = minor + 1;
  return `${hasV ? 'v' : 'v'}${major}.${nextMinor}.0`;
}

// ── Display helpers ───────────────────────────────────────────────────────

export function statusLabel(s: StageStatus): string {
  switch (s.status) {
    case 'running':
      return 'Running';
    case 'idle':
      return 'Idle';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    case 'starting':
      return 'Starting';
    case 'restarting':
      return 'Restarting';
    case 'stopped':
      return 'Stopped';
  }
}

export function statusDotColor(s: StageStatus): string {
  switch (s.status) {
    case 'running':
      return '#4ade80';
    case 'idle':
      return '#94a3b8';
    case 'paused':
    case 'starting':
    case 'restarting':
    case 'stopped':
      return '#a8a29e';
    case 'error':
      return '#f87171';
  }
}

export function throughputLabel(s: StageStatus): string {
  return s.throughput > 0 ? `${s.throughput}` : '—';
}

/** Tooltip for the Pending cell — spells out the ready vs blocked split so an
 * operator can tell "nothing to do" apart from "stalled behind an upstream
 * stage" without opening the row. */
export function pendingTitle(s: StageStatus): string {
  const ready = s.ready.toLocaleString();
  if (s.blocked === 0) {
    return `${ready} ready to run`;
  }
  const blocked = s.blocked.toLocaleString();
  const total = s.pending.toLocaleString();
  return `${ready} ready · ${blocked} blocked on an upstream stage · ${total} pending total`;
}

/** Why a stage paused ITSELF — `meili` does this when Meilisearch's address
 * policy rejects the embedding server (#3315), so the row must say so or the
 * operator's first move is to resume it straight back into the same failure.
 * Null for an operator pause (no reason recorded) and for a running stage:
 * the server clears the reason on every resume, and a stale reason on a row
 * that is no longer paused would be misleading. */
export function pauseReason(s: StageStatus): string | null {
  const reason = s.config?.pause_reason?.trim() ?? '';
  return s.config?.paused === true && reason.length > 0 ? reason : null;
}

/** Format a byte count compactly: 13478912 → "12.9 MB". */
export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Format an ISO 8601 string as a locale-aware date+time. Empty for null. */
/** Header note for the worker-computed counts (#3491): pending / ready / dead
 * are counted by the worker on its own cadence and persisted, so the page
 * says when they were taken instead of pretending they are live. */
export function countsAsOfLabel(countsAt: number | null | undefined): string {
  if (countsAt == null) return 'Counting…';
  return `Counts as of ${new Date(countsAt).toLocaleTimeString()}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

// ── Error normalisation ───────────────────────────────────────────────────

/** Extract a human message from an HttpClient error / Error / unknown
 * thrown value. Handles the common `{ error: { error: "…" } }` shape Bun
 * produces. */
export { errorMessage } from '@maple-common';
