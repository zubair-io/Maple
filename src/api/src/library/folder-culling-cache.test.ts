import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, stat, symlink, utimes, writeFile } from '../fs/mirrored.ts';
import * as culling from './folder-culling.ts';
import { forgetFolderCullingForTests, readFolderCulling } from './folder-culling-cache.ts';

const sidecar = (rating: number) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${rating}"/>` +
  `</rdf:RDF></x:xmpmeta>`;

describe('readFolderCulling', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maple-culling-cache-'));
    forgetFolderCullingForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses an unchanged sidecar once across listings', async () => {
    const path = join(dir, 'a.xmp');
    await writeFile(path, sidecar(3));
    const parse = spyOn(culling, 'parseFolderCulling');
    try {
      expect((await readFolderCulling(path)).culling).toMatchObject({ rating: 3 });
      expect((await readFolderCulling(path)).culling).toMatchObject({ rating: 3 });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('re-reads a same-size rewrite even when its mtime is restored', async () => {
    const path = join(dir, 'a.xmp');
    await writeFile(path, sidecar(3));
    const before = await stat(path);
    expect((await readFolderCulling(path)).culling).toMatchObject({ rating: 3 });
    await writeFile(path, sidecar(5));
    await utimes(path, before.atime, before.mtime);
    expect((await readFolderCulling(path)).culling).toMatchObject({ rating: 5 });
  });

  it('re-reads a sidecar replaced by rename', async () => {
    const path = join(dir, 'a.xmp');
    await writeFile(path, sidecar(1));
    expect((await readFolderCulling(path)).culling).toMatchObject({ rating: 1 });
    await writeFile(join(dir, 'tmp.xmp'), sidecar(4));
    await Bun.$`mv ${join(dir, 'tmp.xmp')} ${path}`.quiet();
    expect((await readFolderCulling(path)).culling).toMatchObject({ rating: 4 });
  });

  it('refuses to follow a final-component symlink', async () => {
    await writeFile(join(dir, 'real.xmp'), sidecar(2));
    await symlink(join(dir, 'real.xmp'), join(dir, 'link.xmp'));
    expect(readFolderCulling(join(dir, 'link.xmp'))).rejects.toThrow();
  });
});
