/**
 * A stitch `maple-cli` refused for lack of memory or scratch space (#5835).
 *
 * The CLI estimates its own peak before it decodes and again before it
 * composites, and checks the temp volume before it writes the decoded frames;
 * instead of running out of either it writes a `refused` block to its report
 * and exits. The sentence built here is the job's error, which the merge
 * dialog and the Apple merge sheet show as it is.
 */

export interface PanoRefusal {
  reason: 'memory' | 'scratch_space';
  neededBytes: number;
  availableBytes: number;
}

const isByteCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function refusedBlock(report: unknown): object | null {
  if (typeof report !== 'object' || report === null || !('refused' in report)) return null;
  const block = report.refused;
  return typeof block === 'object' ? block : null;
}

export function parseRefusal(report: unknown): PanoRefusal | null {
  const block = refusedBlock(report);
  if (block === null) return null;
  if (!('reason' in block) || !('needed_bytes' in block) || !('available_bytes' in block)) {
    return null;
  }
  const { reason, needed_bytes: needed, available_bytes: available } = block;
  if (reason !== 'memory' && reason !== 'scratch_space') return null;
  if (!isByteCount(needed) || !isByteCount(available)) return null;
  return { reason, neededBytes: needed, availableBytes: available };
}

/** The refusal in the CLI's report, or null when the run failed some other way. */
export async function readRefusal(reportFile: string): Promise<PanoRefusal | null> {
  return Bun.file(reportFile)
    .json()
    .then(parseRefusal, () => null);
}

const TENTH_OF_A_GB = 1e8;

// What is needed rounds up and what there is rounds down, so the two never
// print as the same figure.
export function refusalMessage(refusal: PanoRefusal): string {
  const needed = `${(Math.ceil(refusal.neededBytes / TENTH_OF_A_GB) / 10).toFixed(1)} GB`;
  const available = `${(Math.floor(refusal.availableBytes / TENTH_OF_A_GB) / 10).toFixed(1)} GB`;
  return refusal.reason === 'memory'
    ? `This panorama needs about ${needed} of memory to merge, and the server allows ${available}. ` +
        'Merge fewer photos, or ask the server’s owner to raise “Decode memory budget” in Settings → Workers.'
    : `This panorama needs about ${needed} of temporary disk space on the server, and ${available} is free. ` +
        'Merge fewer photos, or ask the server’s owner to free up space.';
}
