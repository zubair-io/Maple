// Tests for the pure VM module behind `workers.component.ts`.
//
// Lives next to the component per the `*.vm.ts` co-location pattern
// (#190). These tests pull plain functions, build minimal fixtures, and
// assert behaviour without spinning up TestBed — that's the whole point
// of the split.

import { describe, it, expect } from 'vitest';
import type { EnrichmentConfigResponse, StageStatus, WorkerConfig } from '@maple-common';
import {
  CONCURRENCY_MAX,
  DEFAULT_RUNTIME,
  ERROR_POLL_MS,
  POLL_MS,
  STAGE_META,
  blankEnrichment,
  blankRuntime,
  formatBytes,
  formatDate,
  groupStagesByPipeline,
  isWhisperModelTier,
  meilisearchFormToPatch,
  parseClampedInt,
  pendingTitle,
  runtimeFormToPatch,
  stageMeta,
  statusDotColor,
  statusLabel,
  summarizeStages,
  throughputLabel,
} from './workers.vm';

describe('isWhisperModelTier', () => {
  it('accepts only supported model tiers', () => {
    expect(isWhisperModelTier('medium.en')).toBe(true);
    expect(isWhisperModelTier('tampered-tier')).toBe(false);
  });
});

// ── Fixture builders ───────────────────────────────────────────────────────

function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    concurrency: 4,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 1,
    ...overrides,
  };
}

function stage(overrides: Partial<StageStatus> = {}): StageStatus {
  return {
    name: 'hash',
    status: 'running',
    inFlight: 0,
    configured: 4,
    pending: 0,
    ready: 0,
    blocked: 0,
    dead: 0,
    throughput: 0,
    lastError: null,
    config: workerConfig(),
    batchSize: 10,
    ...overrides,
  };
}

// ── Polling cadence ────────────────────────────────────────────────────────

describe('polling cadence constants', () => {
  it('exports the operator-visible cadences', () => {
    expect(POLL_MS).toBe(2_000);
    expect(ERROR_POLL_MS).toBe(5_000);
  });
});

// ── stageMeta ───────────────────────────────────────────────────────────────

describe('stageMeta', () => {
  it('returns the canonical metadata for a known stage', () => {
    const m = stageMeta('describe');
    expect(m.group).toBe('Enrich');
    expect(m.enrichment).toBe('describe');
    expect(m.icon).toBe('sparkle');
  });

  it('falls back to Ingest/pipe for unknown stages so a new worker still renders', () => {
    const m = stageMeta('experiment-99');
    expect(m.group).toBe('Ingest');
    expect(m.icon).toBe('pipe');
    expect(m.enrichment).toBeNull();
    expect(m.description).toBe('');
  });

  it('STAGE_META exposes Ingest/Enrich/Index buckets', () => {
    expect(STAGE_META['hash'].group).toBe('Ingest');
    expect(STAGE_META['face-detect'].group).toBe('Enrich');
    expect(STAGE_META['face-detect'].enrichment).toBe('face-detect');
    expect(STAGE_META['face-embed'].group).toBe('Enrich');
    expect(STAGE_META['face-embed'].enrichment).toBe('face-embed');
    expect(STAGE_META['meili'].group).toBe('Index');
  });
});

// ── parseClampedInt ─────────────────────────────────────────────────────────

describe('parseClampedInt', () => {
  it('parses an in-range int through', () => {
    expect(parseClampedInt('7', 1, 32, 2)).toBe(7);
  });

  it('clamps below the minimum', () => {
    expect(parseClampedInt('0', 1, 32, 2)).toBe(1);
  });

  it('clamps above the maximum', () => {
    expect(parseClampedInt('99', 1, 32, 2)).toBe(32);
  });

  it('falls back when the value is not numeric', () => {
    expect(parseClampedInt('abc', 1, 32, 2)).toBe(2);
    expect(parseClampedInt('', 1, 32, 2)).toBe(2);
  });
});

// ── runtimeFormToPatch ──────────────────────────────────────────────────────

describe('runtimeFormToPatch', () => {
  it('produces a WorkerConfig patch with each knob clamped to its range', () => {
    // Concurrency ceiling is now 100 (#674); pollIntervalMs / batchSize knobs
    // were removed entirely and must not appear in the patch.
    const patch = runtimeFormToPatch({
      concurrency: '250', // > 100 → 100
      maxAttempts: 'oops',
    });
    expect(patch).toEqual({
      concurrency: 100,
      maxAttempts: DEFAULT_RUNTIME.maxAttempts,
    });
    expect('pollIntervalMs' in patch).toBe(false);
    expect('batchSize' in patch).toBe(false);
  });

  it('clamps a sane concurrency through unchanged', () => {
    const patch = runtimeFormToPatch({ concurrency: '64', maxAttempts: '7' });
    expect(patch).toEqual({ concurrency: 64, maxAttempts: 7 });
  });

  it('admits concurrency up to the new 100 ceiling', () => {
    expect(CONCURRENCY_MAX).toBe(100);
    expect(runtimeFormToPatch({ concurrency: '100', maxAttempts: '5' }).concurrency).toBe(100);
  });
});

// ── blankRuntime / blankEnrichment ──────────────────────────────────────────

describe('blankRuntime', () => {
  it('seeds from the stage config when present', () => {
    const form = blankRuntime(stage({ config: workerConfig({ concurrency: 12 }) }));
    expect(form.concurrency).toBe('12');
    expect(form.maxAttempts).toBe('5');
  });

  it('falls back to DEFAULT_RUNTIME when config is null', () => {
    const form = blankRuntime(stage({ config: null }));
    expect(form.concurrency).toBe(String(DEFAULT_RUNTIME.concurrency));
    expect(form.maxAttempts).toBe(String(DEFAULT_RUNTIME.maxAttempts));
  });
});

describe('blankEnrichment', () => {
  it('uses server values when the snapshot is populated', () => {
    const ec: EnrichmentConfigResponse = {
      nominatim_url: 'http://nom.local',
      geocode_worker_enabled: true,
      nominatim_rate_limit_per_sec: 4,
      describe_worker_enabled: true,
      describe_provider: 'ollama',
      describe_provider_url: 'http://ollama.local',
      describe_model: 'qwen3-vl:8b',
      describe_system_prompt: '',
      describe_daily_cap_usd: 0,
      transcribe_model_tier: 'small.en',
      face_worker_enabled: false,
      face_model_dir: '/tmp/models',
      face_detector_url: null,
      face_detector_sha256: null,
      face_recognizer_url: null,
      face_recognizer_sha256: null,
      face_min_detection_size: 0.08,
      meilisearch_url: 'http://meili.local:7700',
      meilisearch_api_key_set: true,
      meilisearch_task_timeout_seconds: 900,
      meilisearch_semantic_enabled: true,
      meilisearch_embedder_url: 'http://ollama.local:11434',
      meilisearch_embedder_model: 'custom-embedder',
      meilisearch_semantic_ratio: 0.7,
      source: {} as EnrichmentConfigResponse['source'],
    };
    const form = blankEnrichment(ec);
    expect(form.nominatim_url).toBe('http://nom.local');
    expect(form.transcribe_model_tier).toBe('small.en');
    expect(form.nominatim_rate_limit_per_sec).toBe('4');
    // describe_model is intentionally absent — the runtime hardcodes
    // qwen3-VL via FIXED_DESCRIBE_MODEL.
    expect('describe_model' in form).toBe(false);
    expect(form.face_model_dir).toBe('/tmp/models');
    expect(form.face_min_detection_size).toBe('0.08');
    expect(form.meilisearch_url).toBe('http://meili.local:7700');
    expect(form.meilisearch_task_timeout_seconds).toBe('900');
    expect(form.meilisearch_semantic_enabled).toBe(true);
    expect(form.meilisearch_embedder_url).toBe('http://ollama.local:11434');
    expect(form.meilisearch_embedder_model).toBe('custom-embedder');
    expect(form.meilisearch_semantic_ratio).toBe('0.7');
    // API key is write-only — never seeded from the response, even when set.
    expect(form.meilisearch_api_key).toBe('');
  });

  it('falls back to safe defaults when snapshot is null', () => {
    const form = blankEnrichment(null);
    expect('describe_model' in form).toBe(false);
    expect(form.nominatim_rate_limit_per_sec).toBe('10');
    expect(form.nominatim_url).toBe('');
    expect(form.meilisearch_url).toBe('');
    expect(form.meilisearch_api_key).toBe('');
    expect(form.meilisearch_task_timeout_seconds).toBe('600');
    expect(form.meilisearch_semantic_enabled).toBe(false);
    expect(form.meilisearch_embedder_url).toBe('http://localhost:11434');
    expect(form.meilisearch_embedder_model).toBe('bge-m3');
    expect(form.meilisearch_semantic_ratio).toBe('0.5');
  });
});

describe('meilisearchFormToPatch', () => {
  it('includes the UI-controlled semantic settings and preserves a blank secret', () => {
    const form = blankEnrichment(null);
    form.meilisearch_url = ' http://meili.local:7700 ';
    form.meilisearch_semantic_enabled = true;
    form.meilisearch_embedder_url = ' http://ollama.local:11434 ';
    form.meilisearch_embedder_model = ' custom-embedder ';
    form.meilisearch_semantic_ratio = '0.65';

    expect(meilisearchFormToPatch(form)).toMatchObject({
      meilisearch_url: 'http://meili.local:7700',
      meilisearch_semantic_enabled: true,
      meilisearch_embedder_url: 'http://ollama.local:11434',
      meilisearch_embedder_model: 'custom-embedder',
      meilisearch_semantic_ratio: 0.65,
    });
    expect(meilisearchFormToPatch(form)).not.toHaveProperty('meilisearch_api_key');
  });

  it('resets a blank semantic blend to the backend default', () => {
    const form = blankEnrichment(null);
    form.meilisearch_semantic_ratio = ' ';

    expect(meilisearchFormToPatch(form).meilisearch_semantic_ratio).toBeNull();
  });
});

// ── Grouping / summary ──────────────────────────────────────────────────────

describe('groupStagesByPipeline', () => {
  it('buckets stages into Ingest / Enrich / Index in pipeline order', () => {
    const grouped = groupStagesByPipeline([
      stage({ name: 'meili' }),
      stage({ name: 'hash' }),
      stage({ name: 'face-detect' }),
      stage({ name: 'face-embed' }),
      stage({ name: 'exif' }),
    ]);
    expect(grouped.map((g) => g.group)).toEqual(['Ingest', 'Enrich', 'Index']);
    const [ingest, enrich, index] = grouped;
    expect(ingest.rows.map((r) => r.name)).toEqual(['hash', 'exif']);
    expect(enrich.rows.map((r) => r.name)).toEqual(['face-detect', 'face-embed']);
    expect(index.rows.map((r) => r.name)).toEqual(['meili']);
  });

  it('routes unknown stages into Ingest', () => {
    const grouped = groupStagesByPipeline([stage({ name: 'experiment-99' })]);
    expect(grouped[0].rows.map((r) => r.name)).toEqual(['experiment-99']);
    expect(grouped[1].rows).toHaveLength(0);
  });
});

describe('summarizeStages', () => {
  it('counts running/paused and sums dead/pending', () => {
    const sum = summarizeStages([
      stage({ status: 'running', pending: 100, dead: 0 }),
      stage({ status: 'running', pending: 50, dead: 2 }),
      stage({ status: 'paused', pending: 0, dead: 1 }),
      stage({ status: 'error', pending: 10, dead: 0 }),
    ]);
    expect(sum).toEqual({ running: 2, paused: 1, dead: 3, pending: 160 });
  });

  it('returns zeros when no stages are reported', () => {
    expect(summarizeStages([])).toEqual({ running: 0, paused: 0, dead: 0, pending: 0 });
  });
});

describe('pendingTitle', () => {
  it('reads "ready to run" when nothing is blocked', () => {
    expect(pendingTitle(stage({ pending: 1247, ready: 1247, blocked: 0 }))).toBe(
      '1,247 ready to run',
    );
  });

  it('spells out the ready / blocked / total split when work is blocked', () => {
    expect(pendingTitle(stage({ pending: 145253, ready: 0, blocked: 145253 }))).toBe(
      '0 ready · 145,253 blocked on an upstream stage · 145,253 pending total',
    );
  });
});

// ── Display helpers ─────────────────────────────────────────────────────────

describe('statusLabel', () => {
  it('labels each status value', () => {
    expect(statusLabel(stage({ status: 'running' }))).toBe('Running');
    expect(statusLabel(stage({ status: 'paused' }))).toBe('Paused');
    expect(statusLabel(stage({ status: 'error' }))).toBe('Error');
    expect(statusLabel(stage({ status: 'starting' }))).toBe('Starting');
    expect(statusLabel(stage({ status: 'restarting' }))).toBe('Restarting');
    expect(statusLabel(stage({ status: 'stopped' }))).toBe('Stopped');
  });
});

describe('statusDotColor', () => {
  it('greens running, greys paused/transitional, reds error', () => {
    expect(statusDotColor(stage({ status: 'running' }))).toBe('#4ade80');
    expect(statusDotColor(stage({ status: 'paused' }))).toBe('#a8a29e');
    expect(statusDotColor(stage({ status: 'starting' }))).toBe('#a8a29e');
    expect(statusDotColor(stage({ status: 'error' }))).toBe('#f87171');
  });
});

describe('throughputLabel', () => {
  it('shows the rate when > 0', () => {
    expect(throughputLabel(stage({ throughput: 18 }))).toBe('18');
  });
  it('shows an em-dash at zero', () => {
    expect(throughputLabel(stage({ throughput: 0 }))).toBe('—');
  });
});

describe('formatBytes', () => {
  it('formats small / mid / large counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    // ≥ 10 in chosen unit drops the decimal.
    expect(formatBytes(13_478_912)).toBe('13 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    // < 10 in chosen unit keeps one decimal.
    expect(formatBytes(8 * 1024 * 1024)).toBe('8.0 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('formatDate', () => {
  it('returns an empty string for null', () => {
    expect(formatDate(null)).toBe('');
  });

  it('renders an ISO string as the host locale string', () => {
    // Locale output varies — assert it's non-empty and round-trips to the
    // same instant the input describes.
    const iso = '2026-05-22T05:00:00Z';
    const out = formatDate(iso);
    expect(out).not.toBe('');
    expect(new Date(out).getTime()).toBe(new Date(iso).getTime());
  });
});
