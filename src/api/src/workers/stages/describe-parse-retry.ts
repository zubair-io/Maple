import type { Logger } from 'pino';
import { VisionParseError } from '../../enrichment/describe-providers/parse-vision-json.ts';

/**
 * Extra model calls after the first when the answer fails VisionDoc
 * validation (an off-list enum, malformed JSON, a missing field). Sampling is
 * nondeterministic, so re-asking the same request almost always yields a
 * valid answer: the prod failures behind #5514 were each a one-off value
 * (`lighting: "indoor"`, `shot_type: "aerial"`), so two independent repeats
 * failing too is vanishingly rare, while each
 * repeat holds a server slot for a full inference (and is billed on paid
 * providers) — two bounds the worst case at three calls per claim.
 */
export const DESCRIBE_INVALID_OUTPUT_RETRIES = 2;

/**
 * Run `attempt`, re-running it when the model's answer fails validation.
 * Transport faults (timeouts, refused connections, 5xx) are never retried
 * here: they propagate on the first throw, and the server pool's failover and
 * circuit breaker own them. Once the retries are spent the last validation
 * error propagates unchanged, so the stage runner records and dead-letters it
 * exactly as before.
 */
export async function retryInvalidModelOutput<T>(
  attempt: () => Promise<T>,
  log: Logger,
  assetId: string,
  retriesLeft = DESCRIBE_INVALID_OUTPUT_RETRIES,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof VisionParseError) || retriesLeft === 0) throw err;
    log.info(
      {
        _id: assetId,
        retry: DESCRIBE_INVALID_OUTPUT_RETRIES - retriesLeft + 1,
        maxRetries: DESCRIBE_INVALID_OUTPUT_RETRIES,
        reason: err.reason,
        field: err.field,
      },
      'describe: model output failed validation, re-asking',
    );
    return retryInvalidModelOutput(attempt, log, assetId, retriesLeft - 1);
  }
}
