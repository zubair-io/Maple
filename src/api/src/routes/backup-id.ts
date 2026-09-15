import { status } from 'elysia';
import { fromHex, isMapleId } from '../indexer/id.ts';

/** Normalize optional client IDs before any upload or sidecar state changes. */
export function backupId(value: string | undefined, header: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isMapleId(value)) throw status(400, { error: `invalid ${header}` });
  return fromHex(value).hex;
}

/** Validate the shared chunk headers before either upload route opens a session. */
export function backupChunkRange(totalBytesRaw: string, range: string, id: string | undefined) {
  const totalBytes = parseInt(totalBytesRaw, 10);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw status(400, { error: 'invalid X-Maple-Total-Bytes' });
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  if (!match) throw status(400, { error: 'invalid Content-Range' });
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const rangeTotal = parseInt(match[3], 10);
  if (end < start) throw status(400, { error: 'invalid Content-Range: end must be >= start' });
  if (end >= rangeTotal) throw status(400, { error: 'invalid Content-Range: end must be < total' });
  if (rangeTotal !== totalBytes) {
    throw status(400, { error: 'Content-Range total mismatch with X-Maple-Total-Bytes' });
  }
  if (end + 1 === rangeTotal && !id) {
    throw status(400, { error: 'X-Maple-Maple-Id required on final chunk' });
  }
  return { start, end, rangeTotal, totalBytes };
}
