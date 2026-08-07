/**
 * Batch-rename orchestrator (#2636) — renders each asset's new filename
 * through the shared `raw-core` template engine (`filename-template.ts`)
 * and applies via `relocateAsset` (same-folder relocate, per that
 * function's now-optional `destinationPath`).
 *
 * Applied SEQUENTIALLY, in caller-supplied order — a shared-destination
 * template (e.g. `"vacation_{n}.{ext}"` with a fixed `{n}`, or two files
 * whose distinguishing tokens happen to collide) can produce the same
 * rendered name for two different files in one batch, colliding with
 * itself mid-batch and not just with a pre-existing file. Running each
 * step's `relocateAsset` call to completion before starting the next is
 * what lets `collision` (auto-suffix/skip/replace/keep-both) see and react
 * to the PREVIOUS step's result, exactly as
 * docs/superpowers/specs/2026-08-04-file-management-design.md § "Rename"
 * requires. `Promise.all`/concurrent application would race every file
 * against the same collision check and is deliberately not used here.
 *
 * Partial-failure semantics match the design doc's batch-operations
 * contract: one file's failure is reported per-item, not rolled back, and
 * does not stop the remaining items from being attempted.
 */

import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { activeFileInfo, relocateAsset, type RelocateAssetInput } from './relocate-asset.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import { extensionChanged, renderTemplatedName, splitStemExt } from './filename-template.ts';

export interface BatchRenameTemplateInput {
  ids: ObjectId[];
  template: string;
  sequenceStart: number;
  sequencePadWidth: number;
}

export interface BatchRenameInput extends BatchRenameTemplateInput {
  collision: RelocateAssetInput['collision'];
}

export type BatchRenameItemResult =
  | {
      id: string;
      kind: 'relocated';
      oldFilename: string;
      newFilename: string;
      newPath: string;
      renamedOnCollision: boolean;
      extensionChanged: boolean;
    }
  | { id: string; kind: 'skipped'; reason: string }
  | { id: string; kind: 'not-found' }
  | { id: string; kind: 'invalid'; error: string }
  | { id: string; kind: 'error'; error: string };

export interface BatchRenamePreviewItem {
  id: string;
  oldFilename: string | null;
  newFilename: string | null;
  error: string | null;
  /** True when a PRIOR item in this same preview rendered the identical
   * `(currentFolder, newFilename)` pair — surfaced so a client can warn
   * about a self-colliding template before the caller ever applies it. Only
   * meaningful within one preview call; it is not a disk-collision check
   * (the design doc's "ask on collision" behaviour belongs to apply, via
   * `collision`). */
  duplicate: boolean;
}

/** Render one item's new name against its live `fileinfo`, without any
 * filesystem or Mongo write — shared by `previewBatchRename` and
 * `batchRenameAssets` so preview and apply always agree on what a given
 * `(template, index)` produces for a given asset. */
async function renderItemName(
  id: ObjectId,
  index: number,
  input: BatchRenameTemplateInput,
): Promise<
  | { kind: 'ok'; oldFilename: string; oldPath: string; newFilename: string }
  | { kind: 'not-found' }
  | { kind: 'error'; error: string }
> {
  const c = await assetsCollection();
  const doc = await c.findOne({ _id: id });
  if (!doc) return { kind: 'not-found' };

  const primary = activeFileInfo(doc);
  if (!primary) return { kind: 'error', error: 'asset has no live location' };

  const { stem, ext } = splitStemExt(primary.filename);
  const rendered = renderTemplatedName({
    template: input.template,
    originalStem: stem,
    ext,
    capturedAtIso: doc.exif?.captured_at ?? null,
    sequenceStart: input.sequenceStart,
    index,
    sequencePadWidth: input.sequencePadWidth,
  });
  if (!rendered.ok) return { kind: 'error', error: rendered.error };
  if (!isSafeFilename(rendered.name)) {
    return { kind: 'error', error: 'rendered filename is not a valid single-segment filename' };
  }

  return {
    kind: 'ok',
    oldFilename: primary.filename,
    oldPath: primary.path,
    newFilename: rendered.name,
  };
}

/** Render every item's new name WITHOUT applying anything — the preview
 * mode the web/Apple batch-rename dialogs use for a live before/after list
 * (#2640-#2642), so those clients don't need to reimplement the template
 * engine to show a preview; this stays server-authoritative for Self
 * Hosted. */
export async function previewBatchRename(
  input: BatchRenameTemplateInput,
): Promise<BatchRenamePreviewItem[]> {
  const seen = new Set<string>();
  const out: BatchRenamePreviewItem[] = [];
  for (let i = 0; i < input.ids.length; i++) {
    const id = input.ids[i]!;
    const rendered = await renderItemName(id, i, input);
    if (rendered.kind === 'not-found') {
      out.push({
        id: id.toHexString(),
        oldFilename: null,
        newFilename: null,
        error: 'not found',
        duplicate: false,
      });
      continue;
    }
    if (rendered.kind === 'error') {
      out.push({
        id: id.toHexString(),
        oldFilename: null,
        newFilename: null,
        error: rendered.error,
        duplicate: false,
      });
      continue;
    }
    const key = `${rendered.oldPath}/${rendered.newFilename}`;
    const duplicate = seen.has(key);
    seen.add(key);
    out.push({
      id: id.toHexString(),
      oldFilename: rendered.oldFilename,
      newFilename: rendered.newFilename,
      error: null,
      duplicate,
    });
  }
  return out;
}

/** Render + apply every item, sequentially, per this module's doc. */
export async function batchRenameAssets(input: BatchRenameInput): Promise<BatchRenameItemResult[]> {
  const results: BatchRenameItemResult[] = [];
  for (let i = 0; i < input.ids.length; i++) {
    const id = input.ids[i]!;
    const idStr = id.toHexString();

    const rendered = await renderItemName(id, i, input);
    if (rendered.kind === 'not-found') {
      results.push({ id: idStr, kind: 'not-found' });
      continue;
    }
    if (rendered.kind === 'error') {
      results.push({ id: idStr, kind: 'invalid', error: rendered.error });
      continue;
    }

    const outcome = await relocateAsset({
      id,
      mode: 'move',
      collision: input.collision,
      destinationFilename: rendered.newFilename,
    });

    switch (outcome.kind) {
      case 'relocated':
        results.push({
          id: idStr,
          kind: 'relocated',
          oldFilename: outcome.oldFilename,
          newFilename: outcome.newFilename,
          newPath: outcome.newPath,
          renamedOnCollision: outcome.renamedOnCollision,
          extensionChanged: extensionChanged(outcome.oldFilename, outcome.newFilename),
        });
        break;
      case 'skipped':
        results.push({ id: idStr, kind: 'skipped', reason: outcome.reason });
        break;
      case 'not-found':
        results.push({ id: idStr, kind: 'not-found' });
        break;
      case 'invalid':
        results.push({ id: idStr, kind: 'invalid', error: outcome.error });
        break;
      case 'error':
        results.push({ id: idStr, kind: 'error', error: outcome.error });
        break;
    }
  }
  return results;
}
