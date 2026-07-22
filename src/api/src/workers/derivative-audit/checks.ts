/**
 * Drift checks for the derivative-audit worker. A stage is only ever re-armed or
 * cleared when it is at its target version and its derivative is verifiably
 * missing/zero-byte (drift) or present (resolved). A below-target (queued) stage
 * — e.g. one this worker just reset — is recorded as NEITHER, so its cooldown
 * mark survives until regeneration actually succeeds. Pure (deps injected) so it
 * unit-tests against temp dirs + a fake R2.
 */
import type { ImageDoc } from '../run-stage.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { resolveThumbPathForAsset, cachePathForAsset } from '../../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { isUndecodableFilename, isVideoFilename } from '../../indexer/media-types.ts';
import { thumbR2Key } from '../../cloudflare/thumb-key.ts';

const THUMB_TARGET = 3;
const PREVIEW_TARGET = 4;
const DESCRIBE_TARGET = 7;
const CF_TARGET = 1;

/** A file-stat-like result — the audit only reads `size` (present AND non-zero).
 * Avoids importing the `node:fs` `Stats` type (fs-import guardrail); the real
 * `statOrNull` return and test stubs both satisfy this structurally. */
export interface StatLike {
  readonly size: number;
}

export interface AuditDeps {
  statOrNull(p: string): Promise<StatLike | null>;
  ffmpegAvailable(): Promise<boolean>;
  /** `null` disables the deep R2 check (R2 unconfigured or turned off). */
  thumbExistsInR2: ((key: string) => Promise<boolean>) | null;
}

/** Per-pass verdict. A stage appears in at most one list; a stage that is
 * below-target or non-applicable appears in neither (mark left untouched). */
export interface AuditResult {
  /** Stage at target, derivative missing/zero-byte → re-arm. */
  drifted: string[];
  /** Stage at target, derivative confirmed present → clear its cooldown mark. */
  resolved: string[];
}

function stageVersion(image: ImageDoc, name: string): number {
  return image.stages?.[name]?.version ?? 0;
}

/** A derivative on disk counts as present only when it exists AND is non-zero —
 * an interrupted write can leave a 0-byte file that must be regenerated. */
async function presentNonZero(deps: AuditDeps, p: string | null): Promise<boolean> {
  if (!p) return false;
  const s = await deps.statOrNull(p);
  return s !== null && s.size > 0;
}

/** Would the thumb/preview stages actually produce a file? Replicates their
 * terminal skips (stub-file, no-video-decoder). */
async function pixelDerivativeExpected(image: ImageDoc, deps: AuditDeps): Promise<boolean> {
  const primary = assetPrimaryFileInfo(image);
  if (!primary) return false;
  if (isUndecodableFilename(primary.filename)) return false;
  if (isVideoFilename(primary.filename) && !(await deps.ffmpegAvailable())) return false;
  return true;
}

/** Record a stage as drifted or resolved — but only when it is at target AND
 * applicable. Otherwise it is recorded as neither, leaving its mark untouched. */
function record(
  res: AuditResult,
  stage: string,
  atTarget: boolean,
  applicable: boolean,
  present: boolean,
): void {
  if (!atTarget || !applicable) return;
  (present ? res.resolved : res.drifted).push(stage);
}

/** Deep R2 check: applicable only when enabled, the asset isn't hidden, and a
 * local thumb exists to sync. `present` is whether the object is in the bucket. */
async function checkR2(
  image: ImageDoc,
  idToSlug: ReadonlyMap<string, string>,
  deps: AuditDeps,
  thumbOk: boolean,
): Promise<{ applicable: boolean; present: boolean }> {
  const off = { applicable: false, present: false };
  if (deps.thumbExistsInR2 === null || image.hidden === true || !thumbOk) return off;
  const primary = assetPrimaryFileInfo(image);
  const slug = primary ? idToSlug.get(primary.library_id.toHexString()) : undefined;
  if (!primary || !slug) return off;
  const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
  return { applicable: true, present: await deps.thumbExistsInR2(key) };
}

export async function evaluateAsset(
  image: ImageDoc,
  libs: ReadonlyMap<string, string>,
  idToSlug: ReadonlyMap<string, string>,
  deps: AuditDeps,
): Promise<AuditResult> {
  const res: AuditResult = { drifted: [], resolved: [] };

  // Original-present guard: a moved/vanished original is discover/reaper's job.
  const absPath = assetAbsPath(image, libs);
  if (!absPath || (await deps.statOrNull(absPath)) === null) return res;

  const expectPixels = await pixelDerivativeExpected(image, deps);

  const thumbPath = resolveThumbPathForAsset(image, libs);
  const thumbOk = await presentNonZero(deps, thumbPath);
  record(
    res,
    'thumb',
    stageVersion(image, 'thumb') >= THUMB_TARGET,
    expectPixels && thumbPath !== null,
    thumbOk,
  );

  const previewPath = cachePathForAsset(image, libs, 'previews', PREVIEW_CACHE_SUFFIX);
  const previewOk = await presentNonZero(deps, previewPath);
  record(
    res,
    'preview',
    stageVersion(image, 'preview') >= PREVIEW_TARGET,
    expectPixels && previewPath !== null,
    previewOk,
  );

  // Description is a DB field; "present" = a non-empty caption. Only actionable
  // when a preview exists on disk for describe to actually run against.
  const descPresent = (image.description ?? '').trim() !== '';
  record(
    res,
    'describe',
    stageVersion(image, 'describe') >= DESCRIBE_TARGET,
    expectPixels && previewOk,
    descPresent,
  );

  const r2 = await checkR2(image, idToSlug, deps, thumbOk);
  record(
    res,
    'cf-thumb-sync',
    stageVersion(image, 'cf-thumb-sync') >= CF_TARGET,
    r2.applicable,
    r2.present,
  );

  return res;
}
