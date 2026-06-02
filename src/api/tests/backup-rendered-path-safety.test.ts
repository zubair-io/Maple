/**
 * Handler regression for the rendered-upload path traversal (#854).
 *
 * A traversal in `X-Maple-Suffix-Override` / `X-Maple-Filename-Ext` must be
 * rejected with 400 — never spliced into the write path. The allowlist runs
 * before the library lookup, so this is Mongo-free; `authedHandle` supplies the
 * bearer the gated route (#853) now requires.
 */
import { describe, it, expect } from 'bun:test';
import { authedHandle } from './helpers/authed-handle.ts';

const LIB = '6a1f0d6ce8603a41eb9b0693'; // valid ObjectId shape

function renderedReq(extra: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${LIB}/backup/rendered`, {
    method: 'POST',
    headers: {
      'X-Maple-Device-Id': 'dev1',
      'X-Maple-Phasset-Id': 'ph1',
      'X-Maple-Target-Rel-Path': '2024/Tokyo/IMG.HEIC',
      'X-Maple-Total-Bytes': '100',
      'Content-Range': 'bytes 0-99/100',
      ...extra,
    },
    body: new Uint8Array(100),
  });
}

describe('rendered upload rejects traversal in filename parts (#854)', () => {
  it('400 on a traversal X-Maple-Suffix-Override', async () => {
    const res = await authedHandle(
      renderedReq({ 'X-Maple-Suffix-Override': '../../../../etc/cron.d/pwn' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on a traversal X-Maple-Filename-Ext', async () => {
    const res = await authedHandle(renderedReq({ 'X-Maple-Filename-Ext': 'jpg/../../../etc/x' }));
    expect(res.status).toBe(400);
  });
});
