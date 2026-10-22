/** Real variant publications must finish before lifecycle eligibility is read. */
import { expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import { callNative } from 'maple';
import { replacementFixture } from './upload-replacement.test-helpers';
import { discardIdenticalReplacement } from './upload-replacement';
import { ObjectId } from '../db/object-id';
import * as fs from '../fs/mirrored';
import {
  writeWorkflowVariant,
  commitWorkflowVariant,
  createWorkflowVariant,
} from '../fs/workflow-variants';
import { serializeSidecarWrites } from '../fs/sidecar-write-order';
import { parseSidecarWorkflow } from '../generated/workflow.generated';

for (const operation of ['ordinary', 'semantic', 'create'] as const) {
  test(`an admitted ${operation} variant publication fences the primary lifecycle`, async () => {
    const f = await replacementFixture();
    const source = path.join(f.library, '.maple/trash/photo.dng');
    const primary = path.join(path.dirname(source), 'photo.xmp');
    const corpus = JSON.parse(
      await fs.readFile(
        new URL('../../../../test-fixtures/workflow/contract-v1.json', import.meta.url),
        'utf8',
      ),
    );
    const workflow = parseSidecarWorkflow(corpus[1]);
    const variant = path.join(path.dirname(source), `photo.v${workflow.variantId}.xmp`);
    const xml = corpus[0].history[0].adjustmentXmp as string;
    const embedded = await callNative('workflowEmbedXmp', [JSON.stringify(workflow), xml]);
    if (!embedded.ok) throw new Error(embedded.error);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalOpen = fs.open;
    const opening = spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(variant + '.tmp.')) {
        const datasync = handle.datasync.bind(handle);
        handle.datasync = async () => {
          if (operation !== 'create') await fs.unlink(variant);
          entered.resolve();
          await release.promise;
          await datasync();
        };
      }
      return handle;
    });
    let saving: Promise<unknown> | undefined;
    let lifecycle: Promise<unknown> | undefined;
    try {
      expect((await f.upload('different')).status).toBe(201);
      await fs.writeFile(f.original, 'old-original');
      if (operation === 'create') await fs.writeFile(primary, xml);
      else await fs.writeFile(variant, embedded.value);
      saving =
        operation === 'ordinary'
          ? writeWorkflowVariant(source, workflow.variantId, embedded.value)
          : operation === 'semantic'
            ? commitWorkflowVariant(
                source,
                workflow.variantId,
                embedded.value,
                embedded.value,
                corpus[0].history[0],
              )
            : createWorkflowVariant(source, workflow);
      await entered.promise;
      let admitted = false;
      lifecycle =
        operation === 'create'
          ? serializeSidecarWrites([primary, source + '.xmp'], async () => {
              admitted = true;
            })
          : discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original).then(
              (value) => {
                admitted = true;
                return value;
              },
            );
      await Bun.sleep(25);
      expect(admitted).toBe(false);
      expect(await fs.readFile(source, 'utf8')).toBe('old-original');
      release.resolve();
      await saving;
      if (operation === 'create') await lifecycle;
      else expect(await lifecycle).toBe(false);
      expect(await fs.readFile(variant, 'utf8')).toContain(workflow.variantId);
      expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).not.toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([saving, lifecycle]);
      opening.mockRestore();
      await f.close();
    }
  });
}
