/**
 * Embedder admission gate for Meilisearch document writes (#3315).
 *
 * Meilisearch 1.50's default address policy (`deny_all_local_ips`) rejects the
 * loopback Ollama URL a native development pair uses. The rejection is
 * deterministic, but it only surfaces at embed time: the settings task that
 * registers the embedder succeeds, and every document task afterwards fails —
 * after Meilisearch's own internal retries (~3.5 min per batch), during which
 * the task queue is held for unrelated work too. Nothing on the Maple side
 * used to stop the `meili` stage or the vector backfill from feeding that
 * queue batch after batch.
 *
 * This module sits in front of every document write when semantic search is
 * on. It asks Meilisearch whether the embedder is admitted (the same hybrid
 * search probe `readMeilisearchSemanticStatus` runs — a query embed through
 * the configured embedder, which is exactly the request the policy rejects,
 * and which fails in milliseconds rather than minutes) and, on a rejection,
 * pauses the `meili` stage with the operator-facing reason and throws BEFORE
 * anything is submitted. The caller's normal retry path then applies: the
 * stage records an attempt and the asset stays claimable for when the
 * operator fixes the policy and resumes; the backfill retains its cursor.
 *
 * A healthy verdict is trusted for `EMBEDDER_PROBE_TTL_MS.healthy` so the
 * per-asset stage path doesn't double Meilisearch's load with a probe per
 * document. A rejection is trusted only briefly (`.rejected`), so a resume
 * after the operator restarts Meilisearch re-checks the live policy instead
 * of bouncing straight back into the pause.
 */

import { child as childLogger } from '../log.ts';
import { pauseStageWithReason } from '../workers/stage-pause.ts';
import type { MeilisearchClient } from './meilisearch-client.ts';
import {
  embeddingPolicyPauseReason,
  isEmbeddingPolicyRejection,
} from './meilisearch-embedding-policy.ts';

const log = childLogger('enrichment:meilisearch-embedding-gate');

/** How long one probe verdict is trusted before the next write re-probes. */
export const EMBEDDER_PROBE_TTL_MS = Object.freeze({ healthy: 60_000, rejected: 5_000 });

/** Thrown instead of submitting a write the embedder policy would reject.
 * `message` is the pause reason written to the stage — the operator sees
 * the same text on the stage row, in `last_error`, and in the backfill's
 * retry error. Deliberately NOT `retryable: false`: the asset must be
 * retried once the policy is fixed, which is what a resume does. */
export class MeilisearchEmbedderPolicyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MeilisearchEmbedderPolicyError';
  }
}

type GateClient = Pick<
  MeilisearchClient,
  'semanticConfigured' | 'semanticStatus' | 'semanticFingerprint'
>;

interface ProbeVerdict {
  /** Vector configuration the verdict was taken against; a reconfigured
   * embedder (new URL/model) invalidates it. */
  fingerprint: string | null;
  checkedAt: number;
  /** The rejection detail, or null when the embedder is admitted. */
  rejection: string | null;
}

const defaultPause = (reason: string): Promise<void> => pauseStageWithReason('meili', reason);

let verdict: ProbeVerdict | null = null;
let pauseStage: (reason: string) => Promise<void> = defaultPause;
let now: () => number = Date.now;

/** Test-only: swap the pause side effect and the clock, and forget any
 * cached verdict. Pass `null` to restore production behaviour. */
export function _configureEmbeddingGateForTests(
  overrides: { pauseStage?: (reason: string) => Promise<void>; now?: () => number } | null,
): void {
  verdict = null;
  pauseStage = overrides?.pauseStage ?? defaultPause;
  now = overrides?.now ?? Date.now;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verdictIsFresh(cached: ProbeVerdict, fingerprint: string | null, at: number): boolean {
  const ttl =
    cached.rejection === null ? EMBEDDER_PROBE_TTL_MS.healthy : EMBEDDER_PROBE_TTL_MS.rejected;
  return cached.fingerprint === fingerprint && at - cached.checkedAt < ttl;
}

async function probeRejection(client: GateClient): Promise<string | null> {
  if (!client.semanticStatus) return null;
  const status = await client.semanticStatus();
  return status.embedderPolicyRejected ? (status.error ?? 'bad uri: Rejected URI') : null;
}

async function currentRejection(client: GateClient): Promise<string | null> {
  const fingerprint = client.semanticFingerprint?.() ?? null;
  const at = now();
  if (verdict !== null && verdictIsFresh(verdict, fingerprint, at)) return verdict.rejection;
  const rejection = await probeRejection(client);
  verdict = { fingerprint, checkedAt: at, rejection };
  return rejection;
}

function rememberRejection(client: GateClient, rejection: string): void {
  verdict = { fingerprint: client.semanticFingerprint?.() ?? null, checkedAt: now(), rejection };
}

async function pauseForRejection(detail: string): Promise<MeilisearchEmbedderPolicyError> {
  const reason = embeddingPolicyPauseReason(detail);
  log.error(
    { err: detail },
    'meili stage paused: Meilisearch rejects the embedding server address — fix the policy, then resume',
  );
  await pauseStage(reason);
  return new MeilisearchEmbedderPolicyError(reason);
}

/**
 * Run one Meilisearch document write behind the admission gate.
 *
 * Passthrough when semantic search is off — no embedder, nothing for the
 * policy to reject. Otherwise a rejected embedder pauses the `meili` stage
 * and throws `MeilisearchEmbedderPolicyError` without calling `write`. A
 * write that still comes back with the rejection (the verdict was cached
 * healthy, or the policy changed under us) pauses the stage the same way and
 * is remembered, so the rest of the current claim batch stops submitting
 * without another probe.
 */
export async function withEmbedderPolicyGate<T>(
  client: GateClient,
  write: () => Promise<T>,
): Promise<T> {
  if (!client.semanticConfigured()) return write();
  const rejection = await currentRejection(client);
  if (rejection !== null) throw await pauseForRejection(rejection);
  try {
    return await write();
  } catch (error) {
    const message = errorMessage(error);
    if (!isEmbeddingPolicyRejection(message)) throw error;
    rememberRejection(client, message);
    throw await pauseForRejection(message);
  }
}
