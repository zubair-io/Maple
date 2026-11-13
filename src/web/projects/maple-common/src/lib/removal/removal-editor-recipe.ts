import type { PassthroughBucket } from '../xmp/xmp.types';

/** Replace only the managed record list; all unrelated source XML survives. */
export function withRemovalRecords(
  prior: PassthroughBucket | undefined,
  records: string,
): PassthroughBucket {
  return {
    ...prior,
    unknownAttributes: [
      ...(prior?.unknownAttributes ?? []).filter((a) => a.name !== 'papp:InpaintRemovals'),
      { name: 'papp:InpaintRemovals', value: records },
    ],
    unknownNodes: prior?.unknownNodes ?? [],
  };
}
