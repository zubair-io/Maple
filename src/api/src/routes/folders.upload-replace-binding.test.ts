/** Streamed sidecars cannot attach a displaced photo's edits to its replacement. */
import { expect, test, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers';
import { insertFolder } from '../db/sqlite/test-sqlite.test-helpers';
import { mkdir, readFile, stat, writeFile } from '../fs/mirrored';
import { relocateFile } from '../fs/relocate';
import { writeXmpAtomic } from '../fs/xmp';
import { resolveAndAuthorizeSidecarWrite } from './xmp-path-auth';
import { foldersRoutes } from './folders';
import * as mirrored from '../fs/mirrored';
import { fakeAuth } from '../../tests/helpers/test-auth';

for (const mode of ['copy', 'move'] as const) {
  for (const filename of [
    'photo.xmp',
    'photo.dng.xmp',
    'photo.v12345678-1234-1234-1234-123456789abc.xmp',
    'PHOTO.V12345678-1234-1234-1234-123456789ABC.XMP',
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

test('a same-name raw upload crossing owner lookup refuses the older sidecar upload', async () => {
  const f = await recoveryFixture();
  const destination = path.join(f.root, 'photo.dng');
  const sidecar = path.join(f.root, 'photo.xmp');
  let listing: ReturnType<typeof spyOn> | undefined;
  try {
    await writeFile(destination, 'displaced original');
    const id = insertFolder(f.live.db, { path: f.root });
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const original = mirrored.readdir;
    let replaced = false;
    listing = spyOn(mirrored, 'readdir').mockImplementation((async (
      ...args: Parameters<typeof original>
    ) => {
      const names = await original(...args);
      if (!replaced && String(args[0]) === f.root) {
        replaced = true;
        const response = await app.handle(
          new Request(`http://localhost/api/folders/${id}/upload`, {
            method: 'POST',
            headers: { 'X-Maple-Target-Path': 'photo.dng' },
            body: 'incoming original',
          }),
        );
        expect(response.status).toBe(201);
      }
      return names;
    }) as typeof original);
    const response = await app.handle(
      new Request(`http://localhost/api/folders/${id}/upload`, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': 'photo.xmp' },
        body: 'displaced photo edits',
      }),
    );
    expect(replaced).toBe(true);
    expect({ status: response.status, body: await response.text() }).toMatchObject({ status: 409 });
    expect(await readFile(destination, 'utf8')).toBe('incoming original');
    await expect(stat(sidecar)).rejects.toThrow();
  } finally {
    listing?.mockRestore();
    await f.close();
  }
});

for (const otherLibrary of [false, true]) {
  test(`an unrelated replacement ${otherLibrary ? 'in another library' : 'beside the photo'} does not reject sidecar admission`, async () => {
    const f = await recoveryFixture();
    let listing: ReturnType<typeof spyOn> | undefined;
    try {
      const otherRoot = otherLibrary ? path.join(f.root, 'other-library') : f.root;
      await mkdir(otherRoot, { recursive: true });
      await writeFile(path.join(f.root, 'photo.dng'), 'original photo');
      await writeFile(path.join(otherRoot, 'unrelated.dng'), 'unrelated original');
      const id = insertFolder(f.live.db, { path: f.root });
      const otherId = otherLibrary ? insertFolder(f.live.db, { path: otherRoot }) : id;
      const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
      const original = mirrored.readdir;
      let replaced = false;
      listing = spyOn(mirrored, 'readdir').mockImplementation((async (
        ...args: Parameters<typeof original>
      ) => {
        const names = await original(...args);
        if (!replaced && String(args[0]) === f.root) {
          replaced = true;
          const response = await app.handle(
            new Request(`http://localhost/api/folders/${otherId}/upload`, {
              method: 'POST',
              headers: { 'X-Maple-Target-Path': 'unrelated.dng' },
              body: 'unrelated replacement',
            }),
          );
          expect(response.status).toBe(201);
        }
        return names;
      }) as typeof original);
      const edits =
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description/></rdf:RDF></x:xmpmeta>';
      const response = await app.handle(
        new Request(`http://localhost/api/folders/${id}/upload`, {
          method: 'POST',
          headers: { 'X-Maple-Target-Path': 'photo.xmp' },
          body: edits,
        }),
      );
      expect(replaced).toBe(true);
      expect({ status: response.status, body: await response.text() }).toMatchObject({
        status: 201,
      });
      expect(await readFile(path.join(f.root, 'photo.xmp'), 'utf8')).toBe(edits);
      expect(await readFile(path.join(f.root, 'photo.dng'), 'utf8')).toBe('original photo');
      expect(await readFile(path.join(otherRoot, 'unrelated.dng'), 'utf8')).toBe(
        'unrelated replacement',
      );
    } finally {
      listing?.mockRestore();
      await f.close();
    }
  });
}

for (const stem of [
  'shoot.v12345678-1234-1234-1234-123456789abc',
  'shoot (conflict from Camera)',
]) {
  test(`canonical owner with reserved-looking stem ${stem} keeps its actual replacement binding`, async () => {
    const f = await recoveryFixture();
    const source = path.join(f.root, 'incoming.dng');
    const destination = path.join(f.root, stem + '.dng');
    const sidecar = path.join(f.root, stem + '.xmp');
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let uploading: Promise<Response> | undefined;
    try {
      await writeFile(source, 'incoming original');
      await writeFile(destination, 'displaced original');
      const id = insertFolder(f.live.db, { path: f.root });
      const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            reading.resolve();
            await release.promise;
            controller.enqueue(new TextEncoder().encode('displaced edits'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      uploading = app.handle(
        new Request(`http://localhost/api/folders/${id}/upload`, {
          method: 'POST',
          headers: { 'X-Maple-Target-Path': stem + '.xmp' },
          body,
        }),
      );
      await reading.promise;
      expect(
        (
          await relocateFile({
            sourceAbsPath: source,
            destAbsPath: destination,
            mode: 'copy',
            collision: 'replace',
          })
        ).kind,
      ).toBe('relocated');
      release.resolve();
      expect((await uploading).status).toBe(409);
      expect(await readFile(destination, 'utf8')).toBe('incoming original');
      await expect(stat(sidecar)).rejects.toThrow();
    } finally {
      release.resolve();
      await uploading;
      await f.close();
    }
  });
}

test('raw upload waits for an admitted sidecar publisher and retires its edits with the old primary', async () => {
  const f = await recoveryFixture();
  const destination = path.join(f.root, 'photo.dng');
  const sidecar = path.join(f.root, 'photo.xmp');
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let renaming: ReturnType<typeof spyOn> | undefined;
  let saving: ReturnType<typeof writeXmpAtomic> | undefined;
  let uploading: Promise<Response> | undefined;
  try {
    await writeFile(destination, 'displaced original');
    const id = insertFolder(f.live.db, { path: f.root });
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const admitted = await resolveAndAuthorizeSidecarWrite(destination);
    if (!admitted.ok) throw new Error(admitted.error);
    const original = mirrored.rename;
    renaming = spyOn(mirrored, 'rename').mockImplementation((async (
      ...args: Parameters<typeof original>
    ) => {
      if (String(args[1]) === sidecar && String(args[0]).includes('.tmp.')) {
        publishing.resolve();
        await release.promise;
      }
      return original(...args);
    }) as typeof original);
    const edits =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description/></rdf:RDF></x:xmpmeta>';
    saving = writeXmpAtomic(destination, edits, undefined, admitted.writeScope);
    await publishing.promise;
    uploading = app.handle(
      new Request(`http://localhost/api/folders/${id}/upload`, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': 'photo.dng' },
        body: 'incoming original',
      }),
    );
    await Promise.race([uploading, Bun.sleep(100)]);
    expect(await readFile(destination, 'utf8')).toBe('displaced original');
    release.resolve();
    expect(await saving).toMatchObject({ ok: true });
    expect((await uploading).status).toBe(201);
    expect(await readFile(destination, 'utf8')).toBe('incoming original');
    await expect(stat(sidecar)).rejects.toThrow();
  } finally {
    release.resolve();
    await Promise.allSettled([saving, uploading]);
    renaming?.mockRestore();
    await f.close();
  }
});
