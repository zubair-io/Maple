import { expect, test } from 'bun:test';
import * as path from 'node:path';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers';
import { insertAsset, insertFolder, insertLocation } from '../db/sqlite/test-sqlite.test-helpers';
import { readFile, stat, writeFile } from './mirrored';
import { relocateFile } from './relocate';
import { writeXmpAtomic } from './xmp';
import { resolveAndAuthorizePath } from '../routes/xmp-path-auth';

const edits = (exposure: number) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="${exposure}"/>
</rdf:RDF></x:xmpmeta>`;

for (const mode of ['move', 'copy'] as const) {
  for (const rollback of [false, true]) {
    test(`${mode} Replace ${rollback ? 'rollback admits' : 'commit rejects'} the displaced photo's queued save`, async () => {
      const f = await recoveryFixture();
      const source = path.join(f.root, 'incoming.dng');
      const destination = path.join(f.root, 'photo.dng');
      const sidecar = path.join(f.root, 'photo.xmp');
      let saving: ReturnType<typeof writeXmpAtomic> | undefined;
      const window = Promise.withResolvers<void>();
      try {
        await writeFile(source, 'incoming original');
        await writeFile(destination, 'displaced original');
        await writeFile(sidecar, edits(1));
        const libraryId = insertFolder(f.live.db, { path: f.root });
        const id = insertAsset(f.live.db);
        insertLocation(f.live.db, { assetId: id, libraryId, path: '', filename: 'photo.dng' });
        const authorized = await resolveAndAuthorizePath(destination);
        if (!authorized.ok) throw new Error(authorized.error);
        // Start the independent request outside the relocation's async context.
        saving = (async () => {
          await window.promise;
          return writeXmpAtomic(destination, edits(2), undefined, authorized.writeScope);
        })();
        const outcome = await relocateFile({
          sourceAbsPath: source,
          destAbsPath: destination,
          mode,
          collision: 'replace',
          onVerified: async () => {
            window.resolve();
            await Bun.sleep(25);
            // The old edit is set aside, and the queued save cannot recreate it
            // while the new primary is published but the transaction is uncommitted.
            await expect(stat(sidecar)).rejects.toThrow();
            if (rollback) throw new Error('catalog commit rejected');
          },
        });
        expect(outcome.kind).toBe(rollback ? 'error' : 'relocated');
        const saved = await saving;
        expect(saved).toMatchObject({ ok: rollback });
        expect(await readFile(destination, 'utf8')).toBe(
          rollback ? 'displaced original' : 'incoming original',
        );
        if (rollback) expect(await readFile(sidecar, 'utf8')).toBe(edits(2));
        else await expect(stat(sidecar)).rejects.toThrow();
      } finally {
        window.resolve();
        await saving;
        await f.close();
      }
    });
  }
}
