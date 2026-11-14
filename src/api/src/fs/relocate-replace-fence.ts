/** Replace owns both photos' edit names until filesystem and catalog commit. */
import { withPrimaryReplacement } from './primary-replacement-admission';
import { listPairedSidecars } from './xmp-conflict.ts';
import { xmpSidecarPath } from './xmp.ts';
import { serializeSidecarWrites } from './sidecar-write-order.ts';

/** `companion` is a stack JPEG's `[source, destination]` relocating with the photo (#5929). */
export async function withReplaceSidecarFence<T>(
  source: string,
  destination: string,
  mode: 'move' | 'copy',
  operation: () => Promise<T>,
  companion: readonly [string, string] | readonly [] = [],
): Promise<T> {
  const [companionSource, companionDestination] = companion;
  const destinations = companionDestination ? [destination, companionDestination] : [destination];
  const sources = companionSource ? [source, companionSource] : [source];
  return withPrimarySidecarFence(
    [...sources, ...destinations],
    mode === 'move' ? [...sources, ...destinations] : destinations,
    operation,
  );
}

/** An upload must also wait for sidecar publishers that already validated. */
export function withUploadedPrimaryFence<T>(
  primary: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withPrimarySidecarFence([primary], [primary], operation);
}

async function withPrimarySidecarFence<T>(
  primaries: string[],
  replaced: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const paired = await Promise.all(primaries.map(listPairedSidecars));
  return serializeSidecarWrites(
    [
      ...primaries.flatMap((primary) => [xmpSidecarPath(primary), primary + '.xmp']),
      ...paired.flat(),
    ],
    () => withPrimaryReplacement(replaced, operation),
  );
}
