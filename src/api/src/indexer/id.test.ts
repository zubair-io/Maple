/**
 * Tests for the disk-side helper `hashFileForId`. The pure-bytes helpers
 * (`primary`, `fallback`, `deriveId`) are already covered indirectly by
 * the hash stage tests; this file focuses on the file-IO wrapper so the
 * discover watcher can drop its post-insert hash stage dependency.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha1 } from '@noble/hashes/legacy.js';
import { deriveId, hashFileForId, SHA1_HEAD_BYTES } from './id.ts';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-id-helper-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

describe('hashFileForId', () => {
  test('returns 32-char maple_id, 40-char sha1_head, and accurate stat fields', async () => {
    const file = path.join(tmpDir, 'small.bin');
    const content = Buffer.alloc(70 * 1024, 0xaa);
    await fs.writeFile(file, content);
    const { maple_id, sha1_head, size, mtime } = await hashFileForId(file);
    expect(maple_id).toHaveLength(32);
    expect(maple_id).toMatch(/^[0-9a-f]{32}$/);
    expect(sha1_head).toHaveLength(40);
    expect(sha1_head).toMatch(/^[0-9a-f]{40}$/);
    expect(size).toBe(70 * 1024);
    expect(typeof mtime).toBe('number');
    expect(mtime).toBeGreaterThan(0);
  });

  test('maple_id matches deriveId(head, null, null, null) byte-for-byte', async () => {
    // The discover watcher calls hashFileForId at insert time. The exif
    // stage later upgrades fallback → primary using the same head bytes.
    // Pin the equivalence so a discover-time id never diverges from what
    // the legacy hash stage would have written.
    const file = path.join(tmpDir, 'parity.bin');
    const content = Buffer.alloc(70 * 1024, 0xbe);
    await fs.writeFile(file, content);
    const headOnly = content.subarray(0, SHA1_HEAD_BYTES);
    const expected = deriveId(new Uint8Array(headOnly), null, null, null);
    const { maple_id } = await hashFileForId(file);
    expect(maple_id).toBe(expected.hex);
  });

  test('sha1_head matches sha1(first 64KB) for files larger than the head window', async () => {
    const file = path.join(tmpDir, 'big.bin');
    const content = Buffer.alloc(200 * 1024, 0xcd);
    await fs.writeFile(file, content);
    const expectedSha1 = toHex(sha1(content.subarray(0, SHA1_HEAD_BYTES)));
    const { sha1_head } = await hashFileForId(file);
    expect(sha1_head).toBe(expectedSha1);
  });

  test('handles files smaller than the 64 KB head window', async () => {
    const file = path.join(tmpDir, 'tiny.bin');
    const content = Buffer.from('hello world');
    await fs.writeFile(file, content);
    const expectedSha1 = toHex(sha1(content));
    const { sha1_head, size } = await hashFileForId(file);
    expect(sha1_head).toBe(expectedSha1);
    expect(size).toBe(11);
  });

  test('two files with identical content produce identical maple_id', async () => {
    // The dedup invariant that PR 2 actually depends on. Same bytes → same
    // hash, regardless of filename or directory.
    const a = path.join(tmpDir, 'a.bin');
    const b = path.join(tmpDir, 'b.bin');
    const content = Buffer.alloc(100 * 1024, 0xef);
    await fs.writeFile(a, content);
    await fs.writeFile(b, content);
    const ra = await hashFileForId(a);
    const rb = await hashFileForId(b);
    expect(ra.maple_id).toBe(rb.maple_id);
    expect(ra.sha1_head).toBe(rb.sha1_head);
  });

  test('two files with different content produce different maple_id', async () => {
    const a = path.join(tmpDir, 'c.bin');
    const b = path.join(tmpDir, 'd.bin');
    await fs.writeFile(a, Buffer.alloc(64 * 1024, 0x01));
    await fs.writeFile(b, Buffer.alloc(64 * 1024, 0x02));
    const ra = await hashFileForId(a);
    const rb = await hashFileForId(b);
    expect(ra.maple_id).not.toBe(rb.maple_id);
  });
});
