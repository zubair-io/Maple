// Mock fixtures for the Workers settings page specs.
//
// Split out of `workers.component.spec.ts` (#2311 budget): this is pure test
// data with no dependency on the test scope, and it was three quarters of
// that file. Keeping it here leaves the spec as just its behaviour.

import { Subject } from 'rxjs';
import { WorkerEventsService } from '@maple-common';
import type {
  WorkersStatusResponse,
  WorkersStatusUpdate,
  EnrichmentConfigResponse,
} from '@maple-common';

export const wsFrames = new Subject<WorkersStatusUpdate>();
export const workerEventsStub: Pick<WorkerEventsService, 'workersStatus$'> = {
  workersStatus$: wsFrames.asObservable(),
};

const MOCK_CONFIG = {
  concurrency: 4,
  maxAttempts: 5,
  paused: false,
  last_seen_target_version: 1,
};

export const MOCK_STATUS: WorkersStatusResponse = {
  stages: [
    {
      name: 'hash',
      status: 'running',
      inFlight: 3,
      configured: 4,
      pending: 1247,
      ready: 1247,
      blocked: 0,
      dead: 0,
      throughput: 18,
      lastError: null,
      config: MOCK_CONFIG,
      batchSize: 10,
    },
    {
      name: 'preview',
      status: 'running',
      inFlight: 2,
      configured: 4,
      pending: 500,
      ready: 500,
      blocked: 0,
      dead: 0,
      throughput: 12,
      lastError: null,
      config: MOCK_CONFIG,
      batchSize: 10,
    },
    {
      name: 'face-detect',
      status: 'running',
      inFlight: 1,
      configured: 2,
      pending: 842,
      ready: 800,
      blocked: 42,
      dead: 3,
      throughput: 6,
      lastError: null,
      config: {
        concurrency: 2,
        maxAttempts: 5,
        paused: false,
        last_seen_target_version: 1,
      },
      batchSize: 10,
    },
    {
      name: 'describe',
      status: 'error',
      inFlight: 0,
      configured: 2,
      pending: 842,
      ready: 0,
      blocked: 842,
      dead: 0,
      throughput: 0,
      lastError: 'API key invalid',
      config: {
        concurrency: 2,
        maxAttempts: 5,
        paused: false,
        last_seen_target_version: 1,
      },
      batchSize: 10,
    },
  ],
};

export const MOCK_ENRICHMENT: EnrichmentConfigResponse = {
  nominatim_url: null,
  geocode_worker_enabled: true,
  nominatim_rate_limit_per_sec: 10,
  describe_worker_enabled: true,
  describe_provider: 'ollama',
  describe_provider_url: null,
  describe_servers: [{ url: 'http://localhost:11434', concurrency: 2 }],
  describe_model: 'qwen3-vl:8b',
  describe_system_prompt: '',
  describe_daily_cap_usd: 0,
  transcribe_model_tier: 'medium.en',
  face_worker_enabled: false,
  face_model_dir: '/tmp/.maple/models',
  face_detector_url: null,
  face_detector_sha256: null,
  face_recognizer_url: null,
  face_recognizer_sha256: null,
  face_min_detection_size: 0.06,
  meilisearch_url: null,
  meilisearch_api_key_set: false,
  meilisearch_task_timeout_seconds: 600,
  meilisearch_semantic_enabled: false,
  meilisearch_embedder_url: 'http://localhost:11434',
  meilisearch_embedder_model: 'bge-m3',
  meilisearch_semantic_ratio: 0.5,
  service_search_rate_limit_per_minute: 60,
  source: {
    nominatim_url: 'unset',
    geocode_worker_enabled: 'default',
    nominatim_rate_limit_per_sec: 'default',
    describe_worker_enabled: 'default',
    describe_provider: 'default',
    describe_provider_url: 'unset',
    describe_servers: 'derived',
    describe_model: 'default',
    describe_system_prompt: 'default',
    describe_daily_cap_usd: 'default',
    transcribe_model_tier: 'default',
    face_worker_enabled: 'default',
    face_model_dir: 'default',
    face_detector_url: 'unset',
    face_detector_sha256: 'unset',
    face_recognizer_url: 'unset',
    face_recognizer_sha256: 'unset',
    face_min_detection_size: 'default',
    meilisearch_url: 'unset',
    meilisearch_api_key: 'unset',
    meilisearch_task_timeout_seconds: 'default',
    meilisearch_semantic_enabled: 'default',
    meilisearch_embedder_url: 'default',
    meilisearch_embedder_model: 'default',
    meilisearch_semantic_ratio: 'default',
    service_search_rate_limit_per_minute: 'default',
  },
};
