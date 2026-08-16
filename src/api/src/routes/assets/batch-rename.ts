/**
 * POST /api/assets/batch-rename/preview — dry-run template preview.
 * POST /api/assets/batch-rename         — apply, sequentially (#2636).
 *
 * See `library/batch-rename.ts` for the sequential-application contract
 * (self-collision mid-batch) and
 * docs/superpowers/specs/2026-08-04-file-management-design.md § "Rename".
 *
 * Body (both routes):
 *   ids: string[]                 — ordered asset ids
 *   template: string              — e.g. "{date:%Y%m%d}_{original}_{n}.{ext}"
 *   sequence_start?: number       — default 0
 *   sequence_pad_width?: number   — default 0 (no padding)
 *   collision (apply only): 'auto-suffix' | 'skip' | 'replace' | 'keep-both'
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { batchRenameAssets, previewBatchRename } from '../../library/batch-rename.ts';
import { requireFileAccessBeforeHandle } from '../../auth/middleware.ts';

const TemplateFieldsSchema = {
  ids: t.Array(t.String(), { minItems: 1 }),
  template: t.String({ minLength: 1, maxLength: 512 }),
  sequence_start: t.Optional(t.Number({ minimum: 0 })),
  sequence_pad_width: t.Optional(t.Number({ minimum: 0 })),
};

const BatchRenamePreviewBodySchema = t.Object(TemplateFieldsSchema);

const BatchRenameBodySchema = t.Object({
  ...TemplateFieldsSchema,
  collision: t.Union([
    t.Literal('auto-suffix'),
    t.Literal('skip'),
    t.Literal('replace'),
    t.Literal('keep-both'),
  ]),
});

/** Parse every id, returning `null` at the first malformed one so the route
 * can 400 fast rather than let a bad id surface as a per-item 'not-found'
 * deep in the batch. */
function parseIds(ids: string[]): ObjectId[] | null {
  const out: ObjectId[] = [];
  for (const raw of ids) {
    try {
      out.push(new ObjectId(raw));
    } catch {
      return null;
    }
  }
  return out;
}

export const batchRenameRoutes = new Elysia()
  .post(
    '/batch-rename/preview',
    async ({ body, set }) => {
      const ids = parseIds(body.ids);
      if (!ids) {
        set.status = 400;
        return { error: 'ids contains a malformed asset id' };
      }
      const items = await previewBatchRename({
        ids,
        template: body.template,
        sequenceStart: body.sequence_start ?? 0,
        sequencePadWidth: body.sequence_pad_width ?? 0,
      });
      set.status = 200;
      return {
        items: items.map((it) => ({
          id: it.id,
          old_filename: it.oldFilename,
          new_filename: it.newFilename,
          error: it.error,
          duplicate: it.duplicate,
        })),
      };
    },
    {
      beforeHandle: requireFileAccessBeforeHandle,
      body: BatchRenamePreviewBodySchema,
      detail: {
        summary: 'Preview a batch-rename template over an ordered asset list (no writes)',
        tags: ['assets'],
      },
    },
  )
  .post(
    '/batch-rename',
    async ({ body, set }) => {
      const ids = parseIds(body.ids);
      if (!ids) {
        set.status = 400;
        return { error: 'ids contains a malformed asset id' };
      }
      const results = await batchRenameAssets({
        ids,
        template: body.template,
        sequenceStart: body.sequence_start ?? 0,
        sequencePadWidth: body.sequence_pad_width ?? 0,
        collision: body.collision,
      });
      const summary = {
        total: results.length,
        relocated: results.filter((r) => r.kind === 'relocated').length,
        skipped: results.filter((r) => r.kind === 'skipped').length,
        failed: results.filter(
          (r) => r.kind === 'invalid' || r.kind === 'error' || r.kind === 'not-found',
        ).length,
      };
      set.status = 200;
      return {
        summary,
        results: results.map((r) => {
          switch (r.kind) {
            case 'relocated':
              return {
                id: r.id,
                kind: r.kind,
                old_filename: r.oldFilename,
                new_filename: r.newFilename,
                new_path: r.newPath,
                renamed_on_collision: r.renamedOnCollision,
                extension_changed: r.extensionChanged,
              };
            case 'skipped':
              return { id: r.id, kind: r.kind, reason: r.reason };
            case 'not-found':
              return { id: r.id, kind: r.kind };
            case 'invalid':
            case 'error':
              return { id: r.id, kind: r.kind, error: r.error };
          }
        }),
      };
    },
    {
      beforeHandle: requireFileAccessBeforeHandle,
      body: BatchRenameBodySchema,
      detail: {
        summary: 'Apply a batch-rename template over an ordered asset list, sequentially',
        tags: ['assets'],
      },
    },
  );
