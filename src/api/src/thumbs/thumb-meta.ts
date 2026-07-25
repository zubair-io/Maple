// Freshness protocol for the `.maple/thumbs/` cache, shared by every writer
// and reader so the two cannot drift apart.
//
// Why this exists: the protocol used to live inline in `routes/fs-thumbs.ts`,
// which meant only that route wrote the `<thumb>.meta` sidecar — and its
// freshness check treats a MISSING sidecar as stale. The background `thumb`
// stage writes the same thumb file but never wrote a sidecar, so every
// stage-rendered thumbnail looked stale to the route and was re-decoded from
// source on its first web request (measured 1.4-2.6s per HEIC) despite a
// byte-valid AVIF already sitting at exactly the right path. Fixing the
// filename agreement alone did not fix that; the protocol has to be symmetric.
//
// The sidecar records the (mtimeMs, size) of the SOURCE the thumb was rendered
// from. Both fields matter: an overwrite that preserves mtime but changes size
// produces a fresh source ETag, so without the size check a stale thumb would
// be served under a validator claiming it was current.
//
// Raw `node:fs` rather than `fs/mirrored.ts` (allowlisted in `.oxlintrc.json`):
// this sidecar describes a derived, regenerable thumb, and every other writer in
// that tier — `indexer/thumbnailer.ts`, `routes/fs-thumbs.ts`, `thumbs/render.ts`
// — is raw for the same reason. Mirroring the sidecar while the thumb it
// describes is not mirrored would be incoherent, and a mirror that lacks it just
// re-renders once.

import { stat, writeFile, readFile } from 'node:fs/promises';

/** What `<thumbPath>.meta` records: the source stat the thumb was rendered from. */
interface ThumbMeta {
  mtimeMs: number;
  size: number;
}

/** `stat()` result shape both callers already hold. Accepts the BigIntStats
 * union `node:fs` can return by normalising through `Number` at the boundary. */
export interface SourceStat {
  mtimeMs: number | bigint;
  size: number | bigint;
}

function normalize(srcStat: SourceStat): ThumbMeta {
  return { mtimeMs: Number(srcStat.mtimeMs), size: Number(srcStat.size) };
}

function metaPath(thumbPath: string): string {
  return `${thumbPath}.meta`;
}

/**
 * Record the source stat a freshly-written thumb corresponds to.
 *
 * Best-effort: a failed write only costs a regenerate on the next request, so
 * it must never fail the thumb write itself. Call this after the thumb is
 * published (renamed into place), never before — a sidecar describing a thumb
 * that doesn't exist yet would make a concurrent reader treat a partial or
 * absent file as fresh.
 */
export async function writeThumbMeta(thumbPath: string, srcStat: SourceStat): Promise<void> {
  try {
    await writeFile(metaPath(thumbPath), JSON.stringify(normalize(srcStat)));
  } catch {
    /* regenerates next request */
  }
}

/**
 * Whether the cached thumb at `thumbPath` still covers `srcStat`.
 *
 * Requires the sidecar: a thumb with no sidecar cannot be shown to correspond
 * to this exact source revision, so it is treated as stale. Every writer in
 * this codebase calls {@link writeThumbMeta}, so a missing sidecar means the
 * file predates the protocol (or a best-effort write failed) — one regenerate
 * is the correct, self-healing outcome.
 */
export async function isThumbFresh(thumbPath: string, srcStat: SourceStat): Promise<boolean> {
  const want = normalize(srcStat);

  const thumbStat = await stat(thumbPath).catch(() => null);
  if (thumbStat === null) return false;
  if (Number(thumbStat.mtimeMs) < want.mtimeMs) return false;

  const meta = await readThumbMeta(thumbPath);
  return meta !== null && meta.mtimeMs === want.mtimeMs && meta.size === want.size;
}

async function readThumbMeta(thumbPath: string): Promise<ThumbMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPath(thumbPath), 'utf8')) as Partial<ThumbMeta>;
    if (typeof parsed.mtimeMs !== 'number' || typeof parsed.size !== 'number') return null;
    return { mtimeMs: parsed.mtimeMs, size: parsed.size };
  } catch {
    // Missing or unreadable/corrupt sidecar — treat as stale and regenerate.
    return null;
  }
}
