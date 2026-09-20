/**
 * The shape of a stored worker-config document, and the projection that puts
 * it on the wire. No database dependencies in it.
 *
 * One copy, deliberately. {@link sanitizeWorkerConfig} decides which fields
 * `GET /api/workers/status` exposes, so a second copy would be a second set of
 * omissions to keep in step — and the omissions are the part that is actually
 * on the wire. Call this; do not reimplement it next to a new caller.
 */

import type { WorkerConfig } from './run-stage.ts';

/** One stage's configuration document. `name` is the collection's unique key. */
export interface WorkerConfigDoc extends WorkerConfig {
  /** Stage name — the unique key for this collection. */
  name: string;
}

/**
 * The stage fields, and only those, in the shape `/api/workers/status` puts on
 * the wire.
 *
 * An optional key is left out rather than surfaced as a permanent `null`, and
 * a missing required field reads as `undefined`; `JSON.stringify` drops both,
 * so the response body is the same either way. A knob that was removed from
 * `WorkerConfig` but still lingers on an older stored row is dropped simply by
 * not being mentioned here.
 */
export function sanitizeWorkerConfig(doc: WorkerConfigDoc): WorkerConfig {
  return {
    concurrency: doc.concurrency,
    maxAttempts: doc.maxAttempts,
    paused: doc.paused,
    last_seen_target_version: doc.last_seen_target_version,
    // Only present when a stage paused ITSELF with an explanation; an operator
    // pause carries none, so the key is omitted rather than surfaced as a
    // permanent `null` on every row.
    ...(typeof doc.pause_reason === 'string' ? { pause_reason: doc.pause_reason } : {}),
    ...(typeof doc.version === 'string' ? { version: doc.version } : {}),
    ...(typeof doc.prompt_text === 'string' ? { prompt_text: doc.prompt_text } : {}),
    ...(typeof doc.ai_provider === 'string' ? { ai_provider: doc.ai_provider } : {}),
    ...(typeof doc.ai_model === 'string' ? { ai_model: doc.ai_model } : {}),
  };
}
