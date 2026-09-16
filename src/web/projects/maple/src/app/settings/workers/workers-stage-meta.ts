import type { SettingsIconName } from '../settings-icon.component';

export type StageGroup = 'Ingest' | 'Enrich' | 'Index';
export type EnrichmentKind =
  | 'describe'
  | 'transcribe'
  | 'geocode'
  | 'face-detect'
  | 'face-embed'
  | 'meili';

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
      'Vision AI using the assigned provider connections. Runs a multimodal model against the preview cache and produces a structured caption plus OCR text.',
  },
  transcribe: {
    id: 'transcribe',
    group: 'Enrich',
    icon: 'sparkle',
    enrichment: 'transcribe',
    description: 'Transcribes speech in video and audio files with whisper.cpp on the CPU.',
  },
  'video-describe': {
    id: 'video-describe',
    group: 'Enrich',
    icon: 'sparkle',
    // No dedicated config panel: it reuses the same locked model and the
    // same describe-server list as `describe` (edited from that row), and
    // its sampling bounds are code constants, not operator settings.
    enrichment: null,
    description:
      'Samples several frames across a video’s whole duration and sends them to the vision model in one request for a clip-level summary and scene list, instead of only the poster frame.',
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
  'sidecar-metadata-index': {
    id: 'sidecar-metadata-index',
    group: 'Index',
    icon: 'exif',
    enrichment: null,
    description:
      'Updates library metadata from XMP sidecars and refreshes location lookup when GPS changes.',
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
