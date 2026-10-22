/** Streamed sidecars cannot attach a displaced photo's edits to its replacement. */
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers';
import { insertFolder } from '../db/sqlite/test-sqlite.test-helpers';
import { readFile, stat, writeFile } from '../fs/mirrored';
import { relocateFile } from '../fs/relocate';
import { foldersRoutes } from './folders';
import { fakeAuth } from '../../tests/helpers/test-auth';

for (const mode of ['copy', 'move'] as const) {
  for (const filename of [
    'photo.xmp',
    'photo.dng.xmp',
    'photo.v12345678-1234-1234-1234-123456789abc.xmp',
    'photo (conflict from Device).xmp',
  ]) {
    test(`${mode} Replace fences a streamed ${filename} admitted for the displaced photo`, async () => {
      const f = await recoveryFixture();
      const source = path.join(f.root, 'incoming.dng');
      const destination = path.join(f.root, 'photo.dng');
      const sidecar = path.join(f.root, filename);
      const reading = Promise.withResolvers<void>();
      const releaseBody = Promise.withResolvers<void>();
      const verifying = Promise.withResolvers<void>();
      const releaseReplace = Promise.withResolvers<void>();
      let uploading: Promise<Response> | undefined;
      let moving: ReturnType<typeof relocateFile> | undefined;
      try {
        await writeFile(source, 'incoming original');
        await writeFile(destination, 'displaced original');
        const id = insertFolder(f.live.db, { path: f.root });
        const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              reading.resolve();
              await releaseBody.promise;
              controller.enqueue(new TextEncoder().encode('displaced photo edits'));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        );
        uploading = app.handle(
          new Request(`http://localhost/api/folders/${id}/upload`, {
            method: 'POST',
            headers: { 'X-Maple-Target-Path': filename },
            body,
          }),
        );
        await reading.promise;
        moving = relocateFile({
          sourceAbsPath: source,
          destAbsPath: destination,
          mode,
          collision: 'replace',
          onVerified: async () => {
            verifying.resolve();
            await releaseReplace.promise;
          },
        });
        await verifying.promise;
        releaseBody.resolve();
        await Bun.sleep(25);
        await expect(stat(sidecar)).rejects.toThrow();
        releaseReplace.resolve();
        expect((await moving).kind).toBe('relocated');
        const response = await uploading;
        expect(response.status).toBe(409);
        expect(await response.text()).toContain('reload before');
        expect(await readFile(destination, 'utf8')).toBe('incoming original');
        await expect(stat(sidecar)).rejects.toThrow();
      } finally {
        releaseBody.resolve();
        releaseReplace.resolve();
        await Promise.allSettled([uploading, moving]);
        await f.close();
      }
    });
  }
}
