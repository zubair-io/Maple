/** Meilisearch 1.50 rejects disallowed resolved addresses before contacting
 * the embedder (#3315). Its default `deny_all_local_ips` policy blocks the
 * loopback Ollama URL every native development pair uses, and the rejection
 * is deterministic: every document task that needs an embedding fails after
 * Meilisearch's own internal retries (~3.5 min), and the task queue is held
 * for the duration. Keep the original error while making the operator's next
 * step explicit; changing Maple's URL path does not alter that policy. */

const POLICY_REJECTION = /bad uri:\s*Rejected URI/i;

export const EMBEDDING_POLICY_KEY = 'MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS';

export const EMBEDDING_POLICY_HINT = `Meilisearch blocked the embedding server's address. Configure ${EMBEDDING_POLICY_KEY} on the Meilisearch process to allow only the embedding server's IP or network, then retry. See docs/indexer-enrichment.md (Local embedding connectivity).`;

/** True when `message` carries Meilisearch's address-policy rejection. */
export function isEmbeddingPolicyRejection(message: string | null | undefined): boolean {
  return typeof message === 'string' && POLICY_REJECTION.test(message);
}

export function explainEmbeddingPolicyError(message: string): string {
  if (!isEmbeddingPolicyRejection(message) || message.includes(EMBEDDING_POLICY_KEY)) {
    return message;
  }
  return `${message} ${EMBEDDING_POLICY_HINT}`;
}

/** Operator-facing reason written to the `meili` stage's `pause_reason` when
 * the stage pauses itself instead of submitting embed batches that cannot
 * succeed. `detail` is the upstream Meilisearch error, already explained. */
export function embeddingPolicyPauseReason(detail: string): string {
  return `Paused automatically: ${explainEmbeddingPolicyError(detail)} Restart Meilisearch with the corrected policy, then resume this stage.`;
}
