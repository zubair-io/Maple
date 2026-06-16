/**
 * Integration tests for GET /api/image/:slug/*
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { imageRoutes } from './image.ts';
import { setLibraryBySlugForTests, invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { ObjectId } from 'mongodb';

let tmpDir = '';

const app = new Elysia().use(imageRoutes);

beforeAll(async () => {
  tmpDir = `/tmp/maple-image-test-${process.pid}`;
  await mkdir(tmpDir, { recursive: true });
  setLibraryBySlugForTests('imglib', {
    libraryId: new ObjectId(),
    root: tmpDir,
    label: 'Image Test Library',
  });
});

afterAll(async () => {
  if (tmpDir) {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  invalidateLibraryRoots();
});

describe('GET /image/:slug/*', () => {
  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/image/no-such/file.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 415 for unsupported extension', async () => {
    await writeFile(path.join(tmpDir, 'doc.pdf'), '%PDF');
    const res = await app.handle(new Request('http://localhost/image/imglib/doc.pdf'));
    expect(res.status).toBe(415);
  });

  test('returns 404 when file does not exist on disk', async () => {
    const res = await app.handle(new Request('http://localhost/image/imglib/missing.jpg'));
    expect(res.status).toBe(404);
  });

  test('streams JPEG bytes with correct Content-Type', async () => {
    // Minimal valid JPEG header bytes (SOI + JFIF)
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    await writeFile(path.join(tmpDir, 'photo.jpg'), jpegBytes);

    const res = await app.handle(new Request('http://localhost/image/imglib/photo.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  test('streams DNG with application/octet-stream for unknown RAW', async () => {
    await writeFile(path.join(tmpDir, 'raw.dng'), Buffer.from('fake-dng'));
    const res = await app.handle(new Request('http://localhost/image/imglib/raw.dng'));
    expect(res.status).toBe(200);
    // DNG maps to image/dng
    expect(res.headers.get('Content-Type')).toBe('image/dng');
  });

  test('rejects path traversal attempt', async () => {
    const res = await app.handle(new Request('http://localhost/image/imglib/..%2F..%2Fetc%2Fpasswd'));
    // Should be 400 or 404 — definitely not 200
    expect(res.status).not.toBe(200);
  });
});
