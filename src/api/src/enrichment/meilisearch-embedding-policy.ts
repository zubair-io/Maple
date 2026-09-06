/** Meilisearch 1.50 rejects disallowed resolved addresses before contacting
 * the embedder (#3315). Keep the original error while making the operator's
 * next step explicit; changing Maple's URL path does not alter that policy. */
export function explainEmbeddingPolicyError(message: string): string {
  if (!/bad uri:\s*Rejected URI/i.test(message)) return message;
  return `${message} Meilisearch blocked the embedding server's address. Configure MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS on the Meilisearch process to allow only the embedding server's IP or network, then retry. See docs/indexer-enrichment.md (Local embedding connectivity).`;
}
