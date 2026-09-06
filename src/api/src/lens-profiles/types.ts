/** User-supplied calibration, identified by the shared core's exact byte hash. */
export interface LensProfileInventory {
  version: number;
  reference: string;
  name: string | null;
  make: string | null;
  camera: string | null;
  lens: string | null;
  sampleCount: number;
}

export const MAX_LCP_BYTES = 32 * 1024 * 1024;

export function lensProfileDigest(reference: string): string {
  const match = /^lcp1(?:-ack)?:([a-f0-9]{64})$/.exec(reference);
  if (!match) throw new Error('Unsupported or invalid lens-profile reference');
  return match[1]!;
}
