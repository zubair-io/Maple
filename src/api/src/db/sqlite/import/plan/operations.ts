/**
 * Queues and configuration: the job runner, imports and their per-file rows,
 * the indexer and discover queues, per-stage worker config and handler routing,
 * backup and upload sessions, and APNs device tokens.
 *
 * Nothing here is the photo library, so nothing here needed the decomposition
 * the asset document got. Two shapes do change on the way across:
 *
 *  - `progress` and `counts` were subdocuments and are now plain columns,
 *    because a claim query reads them and a JSON payload cannot be indexed
 *    without a generated column nobody would use;
 *  - `worker_config.maxAttempts` is the one camelCase field in an otherwise
 *    snake_case schema, and becomes `max_attempts`. Missing it would leave every
 *    stage at whatever default the repository layer substitutes, which is a
 *    silent behaviour change rather than an error.
 *
 * The lease fields keep their source units: `jobs` and `imports` hold ISO
 * strings, while `mirror_queue` and `discover_frontier` hold epoch
 * milliseconds. The schema mirrors that split rather than unifying it, so the
 * importer does too.
 */

import type { CollectionPlan } from '../types.ts';
import {
  asRecord,
  intOr,
  requireIdHex,
  toBit,
  toEnum,
  toEpochMs,
  toIso,
  toJsonText,
  toNumber,
  toText,
  textOr,
} from '../values.ts';
import { docId, onePerDocument } from './shared.ts';

const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
const IMPORT_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
const IMPORT_FILE_KINDS = ['image', 'sidecar', 'movie'] as const;
const IMPORT_FILE_STATES = ['pending', 'copied', 'skipped_duplicate', 'failed'] as const;
const TASK_KINDS = ['scan_folder', 'gen_thumb', 'extract_exif'] as const;
const TASK_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;
const SESSION_STATES = ['open', 'completed', 'abandoned'] as const;
const APNS_PLATFORMS = ['ios', 'macos'] as const;
const APNS_ENVIRONMENTS = ['sandbox', 'production'] as const;

const EPOCH = new Date(0).toISOString();

const jobsPlan = onePerDocument({
  source: 'jobs',
  table: 'jobs',
  columns: [
    'id',
    'kind',
    'status',
    'locked_by',
    'lease_expires_at',
    'cancel_requested',
    'progress_current',
    'progress_total',
    'error',
    'created_at',
    'updated_at',
    'params',
    'result',
    'ledger',
    'batch_scopes',
  ],
  values: (doc) => {
    const status = toEnum(doc.status, JOB_STATUSES);
    if (status === null) throw new Error(`unknown job status ${String(doc.status)}`);
    const progress = asRecord(doc.progress);
    return [
      docId(doc),
      textOr(doc.kind, ''),
      status,
      toText(doc.locked_by),
      toIso(doc.lease_expires_at),
      toBit(doc.cancel_requested),
      intOr(progress.current, 0),
      intOr(progress.total, 0),
      toText(doc.error),
      toIso(doc.created_at) ?? EPOCH,
      toIso(doc.updated_at) ?? EPOCH,
      toJsonText(doc.payload),
      toJsonText(doc.result),
      toJsonText(doc.checkpoint),
      toJsonText(doc.batch_scopes),
    ];
  },
});

const importsPlan = onePerDocument({
  source: 'imports',
  table: 'imports',
  columns: [
    'id',
    'status',
    'source_root',
    'library_id',
    'library_root',
    'scan_pending',
    'progress_current',
    'progress_total',
    'count_copied',
    'count_skipped',
    'count_failed',
    'error',
    'locked_by',
    'lease_expires_at',
    'cancel_requested',
    'created_at',
    'updated_at',
  ],
  values: (doc) => {
    const status = toEnum(doc.status, IMPORT_STATUSES);
    if (status === null) throw new Error(`unknown import status ${String(doc.status)}`);
    const progress = asRecord(doc.progress);
    const counts = asRecord(doc.counts);
    return [
      docId(doc),
      status,
      textOr(doc.source_root, ''),
      requireIdHex(doc.library_id, 'library_id'),
      textOr(doc.library_root, ''),
      toBit(doc.scan_pending),
      intOr(progress.current, 0),
      intOr(progress.total, 0),
      intOr(counts.copied, 0),
      intOr(counts.skipped, 0),
      intOr(counts.failed, 0),
      toText(doc.error),
      toText(doc.locked_by),
      toIso(doc.lease_expires_at),
      toBit(doc.cancel_requested),
      toIso(doc.created_at) ?? EPOCH,
      toIso(doc.updated_at) ?? EPOCH,
    ];
  },
});

const importFilesPlan = onePerDocument({
  source: 'import_files',
  table: 'import_files',
  columns: ['import_id', 'idx', 'src', 'dest', 'size', 'mtime', 'kind', 'state', 'error'],
  values: (doc) => {
    const kind = toEnum(doc.kind, IMPORT_FILE_KINDS);
    const state = toEnum(doc.state, IMPORT_FILE_STATES);
    if (kind === null) throw new Error(`unknown import file kind ${String(doc.kind)}`);
    if (state === null) throw new Error(`unknown import file state ${String(doc.state)}`);
    return [
      requireIdHex(doc.import_id, 'import_id'),
      intOr(doc.idx, 0),
      textOr(doc.src, ''),
      textOr(doc.dest, ''),
      intOr(doc.size, 0),
      intOr(doc.mtime, 0),
      kind,
      state,
      toText(doc.error),
    ];
  },
});

const indexerQueuePlan = onePerDocument({
  source: 'indexer_queue',
  table: 'indexer_queue',
  columns: ['kind', 'payload', 'status', 'error', 'created_at', 'updated_at'],
  values: (doc) => {
    const kind = toEnum(doc.kind, TASK_KINDS);
    const status = toEnum(doc.status, TASK_STATUSES);
    if (kind === null) throw new Error(`unknown task kind ${String(doc.kind)}`);
    if (status === null) throw new Error(`unknown task status ${String(doc.status)}`);
    return [
      kind,
      toJsonText(doc.payload) ?? '{}',
      status,
      toText(doc.error),
      toIso(doc.created_at) ?? EPOCH,
      toIso(doc.updated_at) ?? EPOCH,
    ];
  },
});

const discoverFrontierPlan = onePerDocument({
  source: 'discover_frontier',
  table: 'discover_frontier',
  columns: ['folder_id', 'dir_path', 'sweep_gen', 'claimed_at', 'enqueued_at', 'hidden_ancestor'],
  values: (doc) => [
    requireIdHex(doc.folder_id, 'folder_id'),
    textOr(doc.dir_path, ''),
    intOr(doc.sweep_gen, 0),
    toEpochMs(doc.claimed_at),
    toEpochMs(doc.enqueued_at) ?? 0,
    toBit(doc.hidden_ancestor),
  ],
});

const workerConfigPlan = onePerDocument({
  source: 'worker_config',
  table: 'worker_config',
  columns: [
    'name',
    'concurrency',
    'max_attempts',
    'paused',
    'pause_reason',
    'last_seen_target_version',
    'version',
    'prompt_text',
    'ai_provider',
    'ai_model',
  ],
  values: (doc) => {
    const name = toText(doc.name);
    if (name === null) throw new Error('worker_config row has no name');
    return [
      name,
      intOr(doc.concurrency, 1),
      intOr(doc.maxAttempts, 3),
      toBit(doc.paused),
      toText(doc.pause_reason),
      intOr(doc.last_seen_target_version, 0),
      toText(doc.version),
      toText(doc.prompt_text),
      toText(doc.ai_provider),
      toText(doc.ai_model),
    ];
  },
});

const stageHandlersPlan = onePerDocument({
  source: 'stage_handlers',
  table: 'stage_handlers',
  columns: ['stage', 'impl', 'url', 'timeout_ms', 'enabled'],
  values: (doc) => {
    const stage = toText(doc.stage);
    const impl = toEnum(doc.impl, ['builtin', 'http'] as const);
    if (stage === null) throw new Error('stage_handlers row has no stage');
    if (impl === null) throw new Error(`unknown handler impl ${String(doc.impl)}`);
    return [stage, impl, toText(doc.url), toNumber(doc.timeout_ms), toBit(doc.enabled)];
  },
});

const backupSessionsPlan = onePerDocument({
  source: 'backup_sessions',
  table: 'backup_sessions',
  columns: [
    'id',
    'library_id',
    'device_id',
    'started_at',
    'last_progress_at',
    'total_count',
    'uploaded_count',
    'failed_count',
  ],
  values: (doc) => [
    docId(doc),
    requireIdHex(doc.library_id, 'library_id'),
    textOr(doc.device_id, ''),
    toIso(doc.started_at) ?? EPOCH,
    toIso(doc.last_progress_at) ?? EPOCH,
    intOr(doc.total_count, 0),
    intOr(doc.uploaded_count, 0),
    intOr(doc.failed_count, 0),
  ],
});

/**
 * The seven-day TTL index is gone, so `expires_at` is computed here from the
 * source's `created_at` and becomes an ordinary column the periodic sweep reads.
 */
const UPLOAD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const uploadSessionsPlan = onePerDocument({
  source: 'upload_sessions',
  table: 'upload_sessions',
  columns: [
    'id',
    'library_id',
    'device_id',
    'phasset_local_id',
    'phasset_cloud_id',
    'target_rel_path',
    'resolved_rel_path',
    'total_bytes',
    'received_bytes',
    'chunk_size',
    'state',
    'maple_id',
    'created_at',
    'updated_at',
    'expires_at',
  ],
  values: (doc) => {
    const state = toEnum(doc.state, SESSION_STATES);
    if (state === null) throw new Error(`unknown upload session state ${String(doc.state)}`);
    const createdAt = toIso(doc.created_at) ?? EPOCH;
    return [
      docId(doc),
      requireIdHex(doc.library_id, 'library_id'),
      textOr(doc.device_id, ''),
      textOr(doc.phasset_local_id, ''),
      toText(doc.phasset_cloud_id),
      textOr(doc.target_rel_path, ''),
      toText(doc.resolved_rel_path),
      intOr(doc.total_bytes, 0),
      intOr(doc.received_bytes, 0),
      intOr(doc.chunk_size, 0),
      state,
      toText(doc.maple_id),
      createdAt,
      toIso(doc.updated_at) ?? createdAt,
      new Date(Date.parse(createdAt) + UPLOAD_SESSION_TTL_MS).toISOString(),
    ];
  },
});

const apnsPlan = onePerDocument({
  source: 'apns_device_tokens',
  table: 'apns_device_tokens',
  columns: ['id', 'user_id', 'device_token', 'platform', 'environment', 'created_at', 'updated_at'],
  values: (doc) => {
    const platform = toEnum(doc.platform, APNS_PLATFORMS);
    const environment = toEnum(doc.environment, APNS_ENVIRONMENTS);
    if (platform === null) throw new Error(`unknown APNs platform ${String(doc.platform)}`);
    if (environment === null) {
      throw new Error(`unknown APNs environment ${String(doc.environment)}`);
    }
    return [
      docId(doc),
      requireIdHex(doc.user_id, 'user_id'),
      textOr(doc.device_token, ''),
      platform,
      environment,
      toIso(doc.created_at) ?? EPOCH,
      toIso(doc.updated_at) ?? EPOCH,
    ];
  },
});

/** Operational plans, in foreign-key order. */
export const OPERATIONS_PLANS: CollectionPlan[] = [
  jobsPlan,
  importsPlan,
  importFilesPlan,
  indexerQueuePlan,
  discoverFrontierPlan,
  workerConfigPlan,
  stageHandlersPlan,
  backupSessionsPlan,
  uploadSessionsPlan,
  apnsPlan,
];
