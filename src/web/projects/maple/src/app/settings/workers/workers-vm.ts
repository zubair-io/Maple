/**
 * WorkersComponent VM — view model logic.
 *
 * All pure logic lives here: stage metadata, grouping, summarisation,
 * formatting, form defaults, error normalisation, clamped int parsing.
 */

import type {
  EnrichmentConfigResponse,
  StageStatus,
  WorkersStatusResponse,
} from '@maple-common';
import type { StageStatusRow } from '../../../../../../api/src/workers/routes.ts';

// Fixed model for describe stages
export const FIXED_DESCRIBE_MODEL = 'qwen2.5-VL';

export type StageGroup = 'Ingest' | 'Enrich' | 'Index';
export type EnrichmentKind = 'describe' | 'geocode' | 'face' | 'meili';

export interface StageMeta {
  name: string;
  displayName: string;
  description: string;
  enrichment: EnrichmentKind | null;
}

export type SaveState = 'idle' | 'saving' | 'success' | 'error';

export interface RuntimeForm {
  concurrency: string;
  maxAttempts: string;
  paused: string;
}

export interface EnrichmentForm {
  describe_provider_url: string;
  nominatim_url: string;
  nominatim_rate_limit_per_sec: string;
  face_model_dir: string;
  face_retinaface_url: string;
  face_retinaface_sha256: string;
  face_mobilefacenet_url: string;
  face_mobilefacenet_sha256: string;
  meilisearch_url: string;
  meilisearch_api_key: string;
}

export const STAGE_META: Record<string, StageMeta> = {
  exif: {
    name: 'exif',
    displayName: 'EXIF',
    description: 'Extracts EXIF metadata from images.',
    enrichment: null,
  },
  thumb: {
    name: 'thumb',
    displayName: 'Thumbnails',
    description: 'Generates thumbnail images.',
    enrichment: null,
  },
  preview: {
    name: 'preview',
    displayName: 'Previews',
    description: 'Generates preview images.',
    enrichment: null,
  },
  describe: {
    name: 'describe',
    displayName: 'Describe',
    description: 'Generates image descriptions using AI.',
    enrichment: 'describe',
  },
  geocode: {
    name: 'geocode',
    displayName: 'Geocode',
    description: 'Extracts location data from images.',
    enrichment: 'geocode',
  },
  face: {
    name: 'face',
    displayName: 'Face',
    description: 'Detects and analyzes faces in images.',
    enrichment: 'face',
  },
  index: {
    name: 'index',
    displayName: 'Index',
    description: 'Indexes image data for search.',
    enrichment: 'meili',
  },
  'missing-reaper': {
    name: 'missing-reaper',
    displayName: 'Missing Reaper',
    description: 'Cleans up references to missing files.',
    enrichment: null,
  },
};

export function blankRuntime(stage: StageStatus): RuntimeForm {
  const config = stage.config;
  return {
    concurrency: config?.concurrency?.toString() ?? '4',
    maxAttempts: config?.maxAttempts?.toString() ?? '3',
    paused: config?.paused ? 'true' : 'false',
  };
}

export function blankEnrichment(config: EnrichmentConfigResponse | null): EnrichmentForm {
  return {
    describe_provider_url: config?.describe_provider_url ?? '',
    nominatim_url: config?.nominatim_url ?? '',
    nominatim_rate_limit_per_sec: config?.nominatim_rate_limit_per_sec?.toString() ?? '',
    face_model_dir: config?.face_model_dir ?? '',
    face_retinaface_url: config?.face_retinaface_url ?? '',
    face_retinaface_sha256: config?.face_retinaface_sha256 ?? '',
    face_mobilefacenet_url: config?.face_mobilefacenet_url ?? '',
    face_mobilefacenet_sha256: config?.face_mobilefacenet_sha256 ?? '',
    meilisearch_url: config?.meilisearch_url ?? '',
    meilisearch_api_key: '',
  };
}

export function runtimeFormToPatch(form: RuntimeForm): Partial<Record<string, unknown>> {
  const result: Partial<Record<string, unknown>> = {};
  const concurrency = parseInt(form.concurrency, 10);
  if (Number.isFinite(concurrency)) {
    result.concurrency = concurrency;
  }
  const maxAttempts = parseInt(form.maxAttempts, 10);
  if (Number.isFinite(maxAttempts)) {
    result.maxAttempts = maxAttempts;
  }
  const paused = form.paused === 'true';
  if (typeof paused === 'boolean') {
    result.paused = paused;
  }
  return result;
}

export function errorMessage(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(2)} ${units[exponent]}`;
}

export function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export function groupStagesByPipeline(stages: StageStatus[]): { group: StageGroup; rows: StageStatus[] }[] {
  const groups: Record<StageGroup, StageStatus[]> = {
    Ingest: [],
    Enrich: [],
    Index: [],
  };

  for (const stage of stages) {
    const meta = STAGE_META[stage.name];
    if (meta?.enrichment === 'describe' || meta?.enrichment === 'geocode' || meta?.enrichment === 'face' || meta?.enrichment === 'meili') {
      if (meta.enrichment === 'describe') groups.Enrich.push(stage);
      else if (meta.enrichment === 'geocode') groups.Enrich.push(stage);
      else if (meta.enrichment === 'face') groups.Enrich.push(stage);
      else groups.Index.push(stage);
    } else if (stage.name === 'missing-reaper') {
      groups.Enrich.push(stage);
    } else {
      groups.Ingest.push(stage);
    }
  }

  return (Object.keys(groups) as StageGroup[]).map((group) => ({
    group,
    rows: groups[group],
  })).filter((g) => g.rows.length > 0);
}

export function summarizeStages(stages: StageStatus[]): {
  total: number;
  running: number;
  paused: number;
  blocked: number;
  dead: number;
} {
  let total = 0,
    running = 0,
    paused = 0,
    blocked = 0,
    dead = 0;

  for (const stage of stages) {
    total++;
    if (stage.status === 'running') running++;
    else if (stage.status === 'paused') paused++;
    blocked += stage.blocked;
    dead += stage.dead;
  }

  return { total, running, paused, blocked, dead };
}

export function statusLabel(stageStatus: StageStatus['status']): string {
  switch (stageStatus) {
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    default:
      return 'Unknown';
  }
}

export function statusDotColor(stageStatus: StageStatus['status']): string {
  switch (stageStatus) {
    case 'running':
      return '#22c55e';
    case 'paused':
      return '#e5e7eb';
    default:
      return '#9ca3af';
  }
}

export function throughputLabel(count: number): string {
  return `${count.toFixed(1)}/s`;
}

export function pendingTitle(stageStatus: StageStatus): string {
  if (stageStatus.blocked > 0) {
    return `${stageStatus.blocked} blocked, ${stageStatus.pending} pending`;
  }
  return `${stageStatus.pending} pending`;
}

export function parseClampedInt(
  value: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
