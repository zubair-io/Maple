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
import type { SettingsIconName } from '../settings-icon.component';

// ── Polling cadence ────────────────────────────────────────────────────────

export const POLL_MS = 2_000;
export const ERROR_POLL_MS = 5_000;

// ── Stage metadata ────────────────────────────────────────────────────────

export type StageGroup = 'Ingest' | 'Enrich' | 'Index';
export type EnrichmentKind = 'describe' | 'geocode' | 'face' | 'meili';

export interface StageMeta {
  readonly id: string;
  readonly group: StageGroup;
  readonly icon: SettingsIconName;
  readonly description: string;
  readonly enrichment: EnrichmentKind | null;
}

// Visual grouping + descriptions for each stage. Stages the server
// reports but we don't recognise still render at the bottom of "Ingest"
// with a default description, so an added worker shows up without code
// changes.
export const STAGE_META: Record<string, StageMeta> = {
  hash: {
    id: 'hash',
    group: 'Ingest',
    icon: 'hash',
    enrichment: null,
    description: 'Computes content hash for each new asset; deduplicates on ingest.',
  },
  exif: {
    id: 'exif',
    group: 'Ingest',
    icon: 'exif',
    enrichment: null,
    description: 'Extracts EXIF/XMP metadata: camera, lens, exposure, GPS, dates.',
  },
  thumb: {
    id: 'thumb',
    group: 'Ingest',
    icon: 'thumb',
    enrichment: null,
    description: 'Generates 256-px grid thumbnails and stores them in the thumb cache.',
  },
  preview: {
    id: 'preview',
    group: 'Ingest',
    icon: 'image',
    enrichment: null,
    description: 'Builds 1280-px preview cache used by the editor and enrichment LLM.',
  },
  describe: {
    id: 'describe',
    group: 'Enrich',
    icon: 'sparkle',
    enrichment: 'describe',
    description:
      'Local vision-LLM via Ollama. Runs a multimodal model against the preview cache and produces a structured caption plus OCR text.',
  },
  geocode: {
    id: 'geocode',
    group: 'Enrich',
    icon: 'globe',
    enrichment: 'geocode',
    description: 'Reverse-geocodes EXIF GPS coordinates against a self-hosted Nominatim instance.',
  },
  face: {
    id: 'face',
    group: 'Enrich',
    icon: 'face',
    enrichment: 'face',
    description: 'Detects faces in cached thumbnails using RetinaFace + MobileFaceNet (ONNX).',
  },
  meili: {
    id: 'meili',
    group: 'Index',
    icon: 'search',
    enrichment: 'meili',
    description: 'Pushes enriched assets to Meilisearch so they show up in the library search.',
  },
};

/** Fallback used when the server reports a stage we don't have metadata for —
 * lands in Ingest with the generic pipe icon and no enrichment panel. */
export function stageMeta(name: string): StageMeta {
  return (
    STAGE_META[name] ?? {
      id: name,
      group: 'Ingest',
      icon: 'pipe',
      description: '',
      enrichment: null,
    }
  );
}

// ── Per-stage form shapes ─────────────────────────────────────────────────

/** Per-stage form state for the runtime knobs in the expanded panel.
 * Lazily populated when a row is first expanded so unsaved values
 * survive a poll without flickering. */
export interface RuntimeForm {
  concurrency: string;
  pollIntervalMs: string;
  batchSize: string;
  maxAttempts: string;
}

/** Per-stage form state for the enrichment domain config. */
export interface EnrichmentForm {
  // Describe — `describe_model` is intentionally absent: the runtime
  // hardcodes qwen2.5-VL (see FIXED_DESCRIBE_MODEL below), so the UI
  // displays it read-only and never sends it.
  describe_provider_url: string;
  // Geocode
  nominatim_url: string;
  nominatim_rate_limit_per_sec: string;
  // Face
  face_model_dir: string;
  face_retinaface_url: string;
  face_retinaface_sha256: string;
  face_mobilefacenet_url: string;
  face_mobilefacenet_sha256: string;
  // Meili (search index)
  meilisearch_url: string;
  // Write-only: always starts blank (the saved key is never echoed). A
  // blank value on save means "leave the saved key unchanged".
  meilisearch_api_key: string;
}

/** Ollama tag the describe stage is locked to at runtime. The structured
 * JSON parser only accepts this model's output shape, so the operator's
 * DB-backed `describe_model` is ignored server-side and the UI surface
 * matches by treating the field as read-only. Mirrors `QWEN_VL_OLLAMA_TAG`
 * + `FIXED_DESCRIBE_MODEL` in `src/api/src/enrichment/enrichment-config.repo.ts`
 * and `src/api/src/workers/stages/describe.ts`. */
export const FIXED_DESCRIBE_MODEL = 'qwen2.5vl:7b';

export type SaveState = 'idle' | 'saving' | 'success' | 'error';

// Single source of truth for runtime-form defaults. Used by both
// `blankRuntime()` (used when a per-field write happens before the row's
// form was seeded) and `saveStagePatch()` (the bounded clamp inputs).
// Keep these in sync with the min/max hints in the template — server-side
// validation is still authoritative.
export const DEFAULT_RUNTIME = Object.freeze({
  concurrency: 2,
  pollIntervalMs: 1000,
  batchSize: 5,
  maxAttempts: 5,
});

/** Seed form values from a stage's persisted config, falling back to
 * `DEFAULT_RUNTIME` per field. */
export function blankRuntime(stage: StageStatus): RuntimeForm {
  const cfg = stage.config;
  return {
    concurrency: String(cfg?.concurrency ?? DEFAULT_RUNTIME.concurrency),
    pollIntervalMs: String(cfg?.pollIntervalMs ?? DEFAULT_RUNTIME.pollIntervalMs),
    batchSize: String(cfg?.batchSize ?? DEFAULT_RUNTIME.batchSize),
    maxAttempts: String(cfg?.maxAttempts ?? DEFAULT_RUNTIME.maxAttempts),
  };
}

/** Seed enrichment-form values from the latest server config snapshot.
 * `describe_model` is not seeded — the runtime hardcodes the model so the
 * UI shows `FIXED_DESCRIBE_MODEL` as a read-only label. */
export function blankEnrichment(ec: EnrichmentConfigResponse | null): EnrichmentForm {
  return {
    describe_provider_url: ec?.describe_provider_url ?? '',
    nominatim_url: ec?.nominatim_url ?? '',
    nominatim_rate_limit_per_sec: String(ec?.nominatim_rate_limit_per_sec ?? 10),
    face_model_dir: ec?.face_model_dir ?? '',
    face_retinaface_url: ec?.face_retinaface_url ?? '',
    face_retinaface_sha256: ec?.face_retinaface_sha256 ?? '',
    face_mobilefacenet_url: ec?.face_mobilefacenet_url ?? '',
    face_mobilefacenet_sha256: ec?.face_mobilefacenet_sha256 ?? '',
    meilisearch_url: ec?.meilisearch_url ?? '',
    // Never seeded from the response — the key is write-only.
    meilisearch_api_key: '',
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
    concurrency: parseClampedInt(form.concurrency, 1, 32, DEFAULT_RUNTIME.concurrency),
    pollIntervalMs: parseClampedInt(
      form.pollIntervalMs,
      100,
      60_000,
      DEFAULT_RUNTIME.pollIntervalMs,
    ),
    batchSize: parseClampedInt(form.batchSize, 1, 100, DEFAULT_RUNTIME.batchSize),
    maxAttempts: parseClampedInt(form.maxAttempts, 1, 20, DEFAULT_RUNTIME.maxAttempts),
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
  paused: number;
  dead: number;
  pending: number;
} {
  return {
    running: stages.filter((s) => s.status === 'running').length,
    paused: stages.filter((s) => s.status === 'paused').length,
    dead: stages.reduce((acc, s) => acc + s.dead, 0),
    pending: stages.reduce((acc, s) => acc + s.pending, 0),
  };
}

// ── Display helpers ───────────────────────────────────────────────────────

export function statusLabel(s: StageStatus): string {
  switch (s.status) {
    case 'running':
      return 'Running';
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
export function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

// ── Error normalisation ───────────────────────────────────────────────────

/** Extract a human message from an HttpClient error / Error / unknown
 * thrown value. Handles the common `{ error: { error: "…" } }` shape Bun
 * produces. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error?: unknown }).error;
    if (inner && typeof inner === 'object' && 'error' in inner) {
      return String((inner as { error: unknown }).error);
    }
    if (typeof inner === 'string') return inner;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
