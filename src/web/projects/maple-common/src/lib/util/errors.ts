/** Extract a human message from an HttpClient error / Error / unknown
 * thrown value. Handles the common `{ error: { error: "…" } }` shape Bun
 * produces. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error?: unknown }).error;
    if (inner && typeof inner === 'object' && 'error' in inner) {
      return String((inner as { error: unknown }).error);
    }
    if (typeof inner === 'string') return inner;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
