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
export type EnrichmentKind =
  | 'describe'
  | 'transcribe'
  | 'geocode'
  | 'face-detect'
  | 'face-embed'
  | 'meili';

const WHISPER_MODEL_TIERS = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3'] as const;
export type WhisperModelTier = (typeof WHISPER_MODEL_TIERS)[number];

export function isWhisperModelTier(value: string): value is WhisperModelTier {
  return (WHISPER_MODEL_TIERS as readonly string[]).includes(value);
}

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
    description:
      'Builds 1280-px preview cache used by the editor and enrichment LLM. Concurrency also caps on-demand regeneration triggered by cache-miss preview requests (e.g. Browse) — an in-process throttle (this API process only) against a synchronized regeneration burst.',
  },
  describe: {
    id: 'describe',
    group: 'Enrich',
    icon: 'sparkle',
    enrichment: 'describe',
    description:
      'Local vision-LLM via Ollama. Runs a multimodal model against the preview cache and produces a structured caption plus OCR text.',
  },
  transcribe: {
    id: 'transcribe',
    group: 'Enrich',
    icon: 'sparkle',
    enrichment: 'transcribe',
    description: 'Transcribes speech in video and audio files with whisper.cpp on the CPU.',
  },
  geocode: {
    id: 'geocode',
    group: 'Enrich',
    icon: 'globe',
    enrichment: 'geocode',
    description: 'Reverse-geocodes EXIF GPS coordinates against a self-hosted Nominatim instance.',
  },
  'face-detect': {
    id: 'face-detect',
    group: 'Enrich',
    icon: 'face',
    enrichment: 'face-detect',
    description:
      'Detects faces in cached thumbnails with the SCRFD-10G ONNX detector, emitting bounding boxes and 5-point landmarks.',
  },
  'face-embed': {
    id: 'face-embed',
    group: 'Enrich',
    icon: 'face',
    enrichment: 'face-embed',
    description:
      'Produces a 512-D identity embedding per detected face with the ArcFace R100 ONNX recognizer, feeding the people-clustering pass.',
  },
  meili: {
    id: 'meili',
    group: 'Index',
    icon: 'search',
    enrichment: 'meili',
    description: 'Pushes enriched assets to Meilisearch so they show up in the library search.',
  },
  'cf-thumb-sync': {
    id: 'cf-thumb-sync',
    group: 'Index',
    icon: 'globe',
    enrichment: null,
    description:
      'Mirrors thumbnails to a Cloudflare R2 edge cache. Starts paused — configure and enable uploads on Settings → Cloudflare first, then resume here.',
  },
  migration: {
    id: 'migration',
    group: 'Ingest',
    icon: 'gear',
    enrichment: null,
    description:
      'Runs one-shot library migrations. Each migration has its own toggle in the panel below; the worker idles until one is enabled.',
  },
  deduplicate: {
    id: 'deduplicate',
    group: 'Ingest',
    icon: 'copy',
    enrichment: null,
    description:
      'Collapses assets found at more than one path down to a single kept copy, moving the surplus originals (and their sidecars) into a reversible _duplicates/ folder. Starts paused — resume to enable.',
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
  maxAttempts: string;
}

/** Per-stage form state for the enrichment domain config. */
export interface EnrichmentForm {
  // Describe — `describe_model` is intentionally absent: the runtime
  // hardcodes qwen3-VL (see FIXED_DESCRIBE_MODEL below), so the UI
  // displays it read-only and never sends it.
  describe_provider_url: string;
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
  service_search_rate_limit_per_minute: string;
}

/** Ollama tag the describe stage is locked to at runtime. The structured
 * JSON parser only accepts this model's output shape, so the operator's
 * DB-backed `describe_model` is ignored server-side and the UI surface
 * matches by treating the field as read-only. Mirrors `QWEN_VL_OLLAMA_TAG`
 * + `FIXED_DESCRIBE_MODEL` in `src/api/src/enrichment/enrichment-config.repo.ts`
 * and `src/api/src/workers/stages/describe.ts`. */
export const FIXED_DESCRIBE_MODEL = 'qwen3-vl:8b';

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
  };
}

/** Seed enrichment-form values from the latest server config snapshot.
 * `describe_model` is not seeded — the runtime hardcodes the model so the
 * UI shows `FIXED_DESCRIBE_MODEL` as a read-only label. */
export function blankEnrichment(ec: EnrichmentConfigResponse | null): EnrichmentForm {
  return {
    describe_provider_url: ec?.describe_provider_url ?? '',
    transcribe_model_tier: ec?.transcribe_model_tier ?? 'medium.en',
    nominatim_url: ec?.nominatim_url ?? '',
    nominatim_rate_limit_per_sec: String(ec?.nominatim_rate_limit_per_sec ?? 10),
    face_model_dir: ec?.face_model_dir ?? '',
    face_detector_url: ec?.face_detector_url ?? '',
    face_detector_sha256: ec?.face_detector_sha256 ?? '',
    face_recognizer_url: ec?.face_recognizer_url ?? '',
    face_recognizer_sha256: ec?.face_recognizer_sha256 ?? '',
    face_min_detection_size: String(ec?.face_min_detection_size ?? 0.06),
    meilisearch_url: ec?.meilisearch_url ?? '',
    // Never seeded from the response — the key is write-only.
    meilisearch_api_key: '',
    meilisearch_task_timeout_seconds: String(ec?.meilisearch_task_timeout_seconds ?? 600),
    service_search_rate_limit_per_minute: String(ec?.service_search_rate_limit_per_minute ?? 60),
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
export { errorMessage } from '@maple-common';
