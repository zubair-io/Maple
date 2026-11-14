/**
 * Opaque `nextCursor` values for the photo search.
 *
 * A newest-first page seeks past the last photo it served (capture time, then id), so photos added
 * or removed between pages never shift the next one. A relevance-ordered or ranked page is an
 * offset into the request's ranked window, and also carries the window's rank pin
 * (`routes/search/pinned-window.ts`): the engine that ranked it, the depths it was ranked at, and a
 * digest of the resolved filters, so a later page continues the same ranking or is refused. Each
 * cursor carries a fingerprint of the filters it was issued for, and is refused for any other
 * request.
 */

import { createHash } from 'node:crypto';
import type { PhotoSeek } from '../../db/repos/service-photos.repo.ts';
import { decodeRankPin, encodeRankPin, type RankPin } from '../search/pinned-window.ts';
import type { PhotoSearchRequest } from './search-body.ts';

export type PhotoCursor =
  | { kind: 'seek'; after: PhotoSeek }
  | { kind: 'offset'; offset: number; pin: RankPin };

interface CursorPayload {
  v: 1;
  f: string;
  s?: [string, string];
  o?: number;
  p?: string;
}

export function requestFingerprint(request: PhotoSearchRequest): string {
  const { personIds, place, capturedFrom, capturedTo, query } = request;
  const filters = JSON.stringify([[...personIds].sort(), place, capturedFrom, capturedTo, query]);
  return createHash('sha256').update(filters).digest('base64url').slice(0, 16);
}

export function encodeCursor(fingerprint: string, cursor: PhotoCursor): string {
  const payload: CursorPayload =
    cursor.kind === 'seek'
      ? { v: 1, f: fingerprint, s: [cursor.after.capturedAt, cursor.after.assetId] }
      : { v: 1, f: fingerprint, o: cursor.offset, p: encodeRankPin(cursor.pin) };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function readPayload(raw: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as CursorPayload) : null;
  } catch {
    return null;
  }
}

/** The cursor, or null when it is malformed or was issued for a different request. */
export function decodeCursor(raw: string, fingerprint: string): PhotoCursor | null {
  const payload = readPayload(raw);
  if (payload === null || payload.v !== 1 || payload.f !== fingerprint) return null;
  const seek = payload.s;
  if (
    Array.isArray(seek) &&
    seek.length === 2 &&
    typeof seek[0] === 'string' &&
    /^[a-f0-9]{24}$/.test(String(seek[1]))
  ) {
    return { kind: 'seek', after: { capturedAt: seek[0], assetId: seek[1] } };
  }
  const pin = typeof payload.p === 'string' ? decodeRankPin(payload.p) : null;
  return Number.isInteger(payload.o) && (payload.o as number) > 0 && pin !== null
    ? { kind: 'offset', offset: payload.o as number, pin }
    : null;
}
