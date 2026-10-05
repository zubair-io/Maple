import { probeWebGlPresent, probeWebGpuPresent } from './image-canvas.present-probes';

// One-time composition checks; a nonzero alpha channel alone is not visible colour.
export async function testPlatformPresent(): Promise<boolean> {
  if (typeof (globalThis as any).vitest !== 'undefined') return true;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  if (typeof OffscreenCanvas === 'undefined') return false;
  return probeWebGlPresent() && (await probeWebGpuPresent());
}
