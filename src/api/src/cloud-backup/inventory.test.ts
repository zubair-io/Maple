import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from '../fs/mirrored.ts';
import {
  captureInventory,
  fileHash,
  releaseCapture,
  validateCapture,
  type CapturedFile,
  type InventoryLocation,
} from './inventory.ts';

describe('backup inventory source jail', () => {
  let temp: string;
  let root: string;
  let captures: CapturedFile[][];
  beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'maple-backup-inventory-'));
    root = path.join(temp, 'library');
    captures = [];
    await mkdir(root);
  });
  afterEach(async () => {
    await Promise.all(captures.map(releaseCapture));
    await rm(temp, { recursive: true, force: true });
  });
  function location(relative_path = 'photo.dng', sourceRoot = root): InventoryLocation {
    return {
      asset_id: 'asset',
      ordinal: 0,
      library_id: 'library',
      root: sourceRoot,
      relative_path,
      original_path: null,
      deleted_at: null,
      hidden: 0,
      apple_rendered_path: null,
    };
  }
  async function capture(item = location()): Promise<CapturedFile[]> {
    const files = await captureInventory(item);
    captures.push(files);
    return files;
  }
  async function bytes(file: CapturedFile, offset = 0): Promise<Uint8Array> {
    return new Uint8Array(await new Response(file.source.open(offset)).arrayBuffer());
  }
  it('preserves original and XMP bytes, conflict pairing, display MIME and deterministic order', async () => {
    const original = new Uint8Array([0, 255, 12, 99]);
    const xmp = Buffer.from(
      '<?xpacket begin="\uFEFF"?>\r\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><unknown:Flag xmlns:unknown="urn:future"> kept </unknown:Flag></x:xmpmeta>\r\n<?xpacket end="w"?>',
    );
    await writeFile(path.join(root, 'photo.dng'), original);
    // Write in reverse order so filesystem enumeration order cannot decide the snapshot.
    await writeFile(path.join(root, 'photo.xmp'), xmp);
    await writeFile(path.join(root, 'photo (conflict from Z).xmp'), xmp);
    await writeFile(path.join(root, 'photo (conflict from A).xmp'), xmp);
    await writeFile(path.join(root, 'photo (2).xmp'), 'unrelated');
    const files = await capture();
    expect(files.map((file) => file.path)).toEqual([
      'photo.dng',
      'photo (conflict from A).xmp',
      'photo (conflict from Z).xmp',
      'photo.xmp',
    ]);
    expect(await bytes(files[0])).toEqual(original);
    expect(files[0].source.name).toBe('photo.dng');
    expect(files[0].source.contentType).toBe('image/x-adobe-dng');
    for (const file of files.slice(1)) {
      expect(Buffer.from(await bytes(file))).toEqual(xmp);
      expect(file.source.sha256).toBe(createHash('sha256').update(xmp).digest('hex'));
      expect(file.source.contentType).toBe('application/rdf+xml');
    }
    await expect(validateCapture(location(), files)).resolves.toBeUndefined();
  });
  it('uses canonical registered root consistently when the configured root is a symlink', async () => {
    await writeFile(path.join(root, 'photo.dng'), 'inside');
    const alias = path.join(temp, 'registered-alias');
    await symlink(root, alias);
    const files = await capture(location('photo.dng', alias));
    expect(files[0].path).toBe('photo.dng');
    expect(files[0].absolutePath).toBe(path.join(await realpath(root), 'photo.dng'));
    expect(Buffer.from(await bytes(files[0])).toString()).toBe('inside');
  });
  it('rejects source files and parent directories that are symlinks outside the library', async () => {
    const outside = path.join(temp, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'photo.dng'), 'outside-secret');
    await symlink(path.join(outside, 'photo.dng'), path.join(root, 'photo.dng'));
    await expect(capture()).rejects.toThrow('symlink');
    await symlink(outside, path.join(root, 'escaped'));
    await expect(capture(location('escaped/photo.dng'))).rejects.toThrow('symlink');
  });
  it('never follows a source replaced by a symlink after capture', async () => {
    await writeFile(path.join(root, 'photo.dng'), 'inside');
    const files = await capture();
    const outside = path.join(temp, 'secret');
    await writeFile(outside, 'outside-secret');
    await unlink(path.join(root, 'photo.dng'));
    await symlink(outside, path.join(root, 'photo.dng'));
    await expect(bytes(files[0])).rejects.toThrow();
  });
  it('fences in-place source edits and newly created sidecars during transfer', async () => {
    await writeFile(path.join(root, 'photo.dng'), 'inside');
    const files = await capture();
    await writeFile(path.join(root, 'photo.xmp'), '<x:xmpmeta/>');
    await expect(validateCapture(location(), files)).rejects.toThrow('sidecar set changed');
    await writeFile(path.join(root, 'photo.dng'), 'replaced-content');
    await expect(bytes(files[0])).rejects.toThrow('changed during reading');
  });
  it('keeps transfer reads pinned when a parent path is replaced mid-stream', async () => {
    await mkdir(path.join(root, 'album'));
    await writeFile(path.join(root, 'album/photo.dng'), Buffer.alloc(600_000, 7));
    const files = await capture(location('album/photo.dng'));
    const reader = files[0].source.open(0).getReader();
    const first = await reader.read();
    expect(first.value?.[0]).toBe(7);
    const outside = path.join(temp, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'photo.dng'), Buffer.alloc(600_000, 99));
    await rename(path.join(root, 'album'), path.join(root, 'old-album'));
    await symlink(outside, path.join(root, 'album'));
    await expect(reader.read()).rejects.toThrow('symlink');
  });
  it('supports exact byte-offset retries and closes pinned descriptors explicitly', async () => {
    await writeFile(path.join(root, 'photo.dng'), '0123456789');
    const files = await capture();
    expect(Buffer.from(await bytes(files[0], 4)).toString()).toBe('456789');
    expect(() => files[0].source.open(-1)).toThrow('Invalid backup read offset');
    await releaseCapture(files);
    await releaseCapture(files);
    await expect(bytes(files[0])).rejects.toThrow();
  });
  it('honors cancellation and rejects hashing a replaced symlink', async () => {
    await writeFile(path.join(root, 'photo.dng'), 'inside');
    const controller = new AbortController();
    controller.abort();
    await expect(captureInventory(location(), controller.signal)).rejects.toThrow();
    const outside = path.join(temp, 'secret');
    await writeFile(outside, 'outside-secret');
    await unlink(path.join(root, 'photo.dng'));
    await symlink(outside, path.join(root, 'photo.dng'));
    await expect(fileHash(path.join(root, 'photo.dng'))).rejects.toThrow();
  });
});
