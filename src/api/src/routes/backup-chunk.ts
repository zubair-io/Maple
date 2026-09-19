/**
 * The chunk half of the two resumable upload routes.
 *
 * `POST .../backup/ingest` and `POST .../backup/rendered` differ in everything
 * around the bytes — one computes a destination from capture date and GPS and
 * then dedups on content, the other derives a companion path from an existing
 * asset — and in nothing at all about the bytes themselves. Both wrote the same
 * ninety lines: append this chunk to the session's tmp file, refuse a client
 * that is behind or ahead, refuse a body that does not match what
 * `Content-Range` claimed, and answer `202` until the last chunk lands.
 *
 * Two copies of that is a bad way to hold it, because every line of it is a
 * guard against silent corruption. The tmp-size check exists so fresh bytes are
 * never appended onto stale ones; the stale-tmp unlink exists so a session that
 * self-healed does not assemble a file from two attempts. A fix applied to one
 * copy and not the other produces a corrupted upload that no status code
 * reports — which is exactly the failure that is hardest to notice afterwards.
 * As one function, both routes get the same guarantees by construction.
 *
 * It answers with a `Response` on every path that ends the request, the way
 * `backup-id.ts` already does for the header checks, so a route stays a list of
 * "do this, and return what comes back if it is a Response".
 *
 * The filesystem calls go through `fs/mirrored.ts` rather than `node:fs`. It
 * makes no difference to what happens — chunk staging lives outside every
 * library root, so the wrapper resolves no mirror target and passes straight
 * through — and it is what the guardrail asks a new module to import, so this
 * one needs no entry in the allowlist.
 */

import path from 'node:path';

import fs from '../fs/mirrored.ts';

import { BACKUP_CHUNK_DIR } from '../backup/config.ts';
import { BusyElsewhereError, uploadSessions } from '../backup/upload-session.ts';
import type { OpenOrResumeArgs } from '../db/repos/upload-sessions.repo.ts';
import type { UploadSessionDoc } from '../db/schema.ts';

/** An upload session, open and ready for this request's chunk. */
export interface OpenSession {
  session: UploadSessionDoc;
  /** The stored session was reset in place after a metadata mismatch. */
  didReset: boolean;
  /** Every byte already landed on a previous attempt. */
  alreadyComplete: boolean;
}

/**
 * Opens or resumes the session this chunk belongs to, turning the two ways it
 * can refuse into the responses the routes owe the device.
 *
 * `423` is the interesting one: it means another device on the same iCloud
 * library is actively uploading the same photo, and `retry_after_seconds` is
 * how long to wait before trying again. `409` is the catch-all for a session
 * whose stored metadata cannot be reconciled with this request.
 */
export async function openChunkSession(args: OpenOrResumeArgs): Promise<Response | OpenSession> {
  try {
    const opened = await uploadSessions.openOrResume(args);
    return {
      session: opened.session,
      didReset: opened.reset,
      alreadyComplete: opened.alreadyComplete,
    };
  } catch (e: unknown) {
    if (e instanceof BusyElsewhereError) {
      return json(423, { error: e.message, retry_after_seconds: e.retryAfterSeconds });
    }
    return json(409, { error: errorMessage(e, 'session metadata mismatch on resume') });
  }
}

/** One chunk, and the session it belongs to. */
export interface ChunkRequest {
  session: UploadSessionDoc;
  /** `openOrResume` reset the session in place, so any tmp bytes are stale. */
  didReset: boolean;
  /** The validated `Content-Range` span, from {@link backupChunkRange}. */
  start: number;
  end: number;
  rangeTotal: number;
  /** The raw request body: the bytes of this chunk. */
  body: unknown;
  /** The content id the final chunk must carry. */
  mapleId: string | undefined;
}

/** The upload is complete: every chunk is in this file, waiting to be moved. */
export interface AssembledUpload {
  tmpFile: string;
  /** Narrowed here so the caller does not re-check what this function refused. */
  mapleId: string;
}

/**
 * Appends one chunk to its session's tmp file.
 *
 * Returns the assembled file only for the final chunk. Every other outcome —
 * including a perfectly good intermediate chunk, which is a `202` — is a
 * `Response` for the route to return unchanged.
 */
export async function takeChunk(request: ChunkRequest): Promise<Response | AssembledUpload> {
  const { session, start, end, rangeTotal } = request;
  const tmpFile = path.join(BACKUP_CHUNK_DIR, `${session._id.toHexString()}.part`);
  await fs.mkdir(BACKUP_CHUNK_DIR, { recursive: true });

  const cleared = request.didReset ? await clearStaleTmp(tmpFile) : null;
  if (cleared !== null) return cleared;

  // The client is behind or ahead of what the session recorded. Telling it the
  // offset we expect is what lets a retry resume rather than start over.
  if (session.received_bytes !== start) {
    return json(409, { error: 'resume offset mismatch', expected_offset: session.received_bytes });
  }

  const buf = toBuffer(request.body);
  const expectedChunkLen = end - start + 1;
  if (buf.byteLength !== expectedChunkLen) {
    return json(400, {
      error: `body length ${buf.byteLength} does not match Content-Range span ${expectedChunkLen}`,
    });
  }

  const consistent = start === 0 ? null : await checkTmpAgainstSession(tmpFile, session);
  if (consistent !== null) return consistent;

  await fs.appendFile(tmpFile, buf);
  await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: buf.byteLength });

  if (end + 1 !== rangeTotal) return json(202, { next_offset: end + 1 });

  // `backupChunkRange` refuses a final chunk with no content id, so this is a
  // backstop rather than the check — but it is the one that narrows the type,
  // and a route that skipped it could file the bytes under `undefined`.
  if (!request.mapleId) return json(400, { error: 'X-Maple-Maple-Id required on final chunk' });
  return { tmpFile, mapleId: request.mapleId };
}

/**
 * Drops the tmp bytes of a session that was reset in place, so the next append
 * starts at offset 0.
 *
 * Only "there was nothing there" is tolerable. Any other failure means the file
 * may still hold the previous attempt's bytes, and appending onto those — which
 * `start === 0` skips the size check for — assembles a file out of two
 * different uploads and moves it into the library as if it were one.
 */
async function clearStaleTmp(tmpFile: string): Promise<Response | null> {
  try {
    await fs.unlink(tmpFile);
    return null;
  } catch (e: unknown) {
    if (errorCode(e) === 'ENOENT') return null;
    return json(500, { error: `could not clear stale tmp file: ${errorMessage(e)}` });
  }
}

/**
 * Confirms the tmp file on disk holds exactly what the session says it holds,
 * before anything is appended to it.
 *
 * A missing file means the database and the disk disagree, and there is no
 * offset the client could resume from, so the session is reset and the client
 * told to start over. A file of the wrong size is recoverable: its length IS
 * the offset the client should send from.
 */
async function checkTmpAgainstSession(
  tmpFile: string,
  session: UploadSessionDoc,
): Promise<Response | null> {
  const stat = await fs.stat(tmpFile).catch(() => null);
  if (stat === null) {
    await uploadSessions.resetForRestart(session._id);
    return json(409, { error: 'tmp file missing — restart required', expected_offset: 0 });
  }
  if (stat.size !== session.received_bytes) {
    return json(409, {
      error: 'tmp file size mismatch — restart required',
      expected_offset: stat.size,
    });
  }
  return null;
}

function toBuffer(body: unknown): Buffer {
  return body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body as ArrayBuffer);
}

function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(e: unknown, fallback = 'unlink failed'): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : fallback;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}
