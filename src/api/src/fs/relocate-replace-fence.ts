/** Replace owns both photos' edit names until filesystem and catalog commit. */
import { withPrimaryReplacement } from './primary-replacement-admission';
import { listPairedSidecars } from './xmp-conflict.ts';
import { xmpSidecarPath } from './xmp.ts';
import { serializeSidecarWrites } from './sidecar-write-order.ts';

export async function withReplaceSidecarFence<T>(
  source: string,
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const paired = await Promise.all([listPairedSidecars(source), listPairedSidecars(destination)]);
  return serializeSidecarWrites(
    [
      xmpSidecarPath(source),
      source + '.xmp',
      xmpSidecarPath(destination),
      destination + '.xmp',
      ...paired.flat(),
    ],
    () => withPrimaryReplacement([source, destination], operation),
  );
}
