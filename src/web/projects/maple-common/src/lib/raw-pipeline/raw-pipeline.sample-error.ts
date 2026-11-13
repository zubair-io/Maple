/** Decode the core's kind-prefixed errors for the actual point samplers. */
export function parseSampleError<K extends string>(
  raw: string,
  kinds: readonly K[],
  fallback: K,
): { kind: K; message: string } {
  const index = raw.indexOf(': ');
  const prefix = index > 0 ? raw.slice(0, index) : '';
  const kind = kinds.find((candidate) => candidate === prefix);
  return kind ? { kind, message: raw.slice(index + 2) } : { kind: fallback, message: raw };
}
