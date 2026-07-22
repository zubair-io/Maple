import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { evaluateAsset, type AuditDeps } from './checks.ts';
import type { ImageDoc } from '../run-stage.ts';

const statOrNull = async (p: string) => {
  try {
    return await stat(p);
  } catch {
    return null;
  }
};

let root: string;
const LIB = new ObjectId();
const libs = new Map<string, string>();
const slugs = new Map<string, string>();

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'audit-checks-'));
  libs.set(LIB.toHexString(), root);
  slugs.set(LIB.toHexString(), 'lib');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeAsset(over: Partial<ImageDoc> = {}): ImageDoc {
  return {
    _id: new ObjectId(),
    maple_id: 'abc123',
    fileinfo: [{ library_id: LIB, path: 'a/b', filename: 'p.dng' }],
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '',
    stages: {
      thumb: { version: 3, attempts: 0, last_error: null, processed_at: null, dead: false },
      preview: { version: 4, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 7, attempts: 0, last_error: null, processed_at: null, dead: false },
      'cf-thumb-sync': {
        version: 1,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
    },
    description: 'a cat',
    ...over,
  } as unknown as ImageDoc;
}

const deps = (over: Partial<AuditDeps> = {}): AuditDeps => ({
  statOrNull,
  ffmpegAvailable: async () => true,
  thumbExistsInR2: null,
  ...over,
});

async function writeOriginal() {
  await mkdir(path.join(root, 'a/b'), { recursive: true });
  await writeFile(path.join(root, 'a/b/p.dng'), 'raw');
}
async function writeThumb() {
  await mkdir(path.join(root, 'a/b/.maple/thumbs'), { recursive: true });
  await writeFile(path.join(root, 'a/b/.maple/thumbs/abc123.avif'), 'thumb');
}
async function writePreview() {
  await mkdir(path.join(root, 'a/b/.maple/previews'), { recursive: true });
  await writeFile(path.join(root, 'a/b/.maple/previews/p.dng.avif'), 'prev');
}

describe('evaluateAsset', () => {
  it('re-arms nothing when the original is missing (leave to discover/reaper)', async () => {
    await rm(path.join(root, 'a/b/p.dng'), { force: true });
    expect(await evaluateAsset(makeAsset(), libs, slugs, deps())).toEqual([]);
  });

  it('re-arms thumb + preview when both derivatives are missing', async () => {
    await writeOriginal();
    await rm(path.join(root, 'a/b/.maple'), { recursive: true, force: true });
    const res = await evaluateAsset(makeAsset(), libs, slugs, deps());
    expect(res.sort()).toEqual(['preview', 'thumb']);
  });

  it('re-arms nothing when both derivatives are present and description set', async () => {
    await writeOriginal();
    await writeThumb();
    await writePreview();
    expect(await evaluateAsset(makeAsset(), libs, slugs, deps())).toEqual([]);
  });

  it('re-arms describe when description is empty but a preview exists', async () => {
    await writeOriginal();
    await writeThumb();
    await writePreview();
    const res = await evaluateAsset(makeAsset({ description: '' }), libs, slugs, deps());
    expect(res).toEqual(['describe']);
  });

  it('does NOT re-arm cf-thumb-sync for a hidden asset even if R2 says absent', async () => {
    await writeOriginal();
    await writeThumb();
    await writePreview();
    const res = await evaluateAsset(
      makeAsset({ hidden: true }),
      libs,
      slugs,
      deps({ thumbExistsInR2: async () => false }),
    );
    expect(res).toEqual([]);
  });

  it('re-arms cf-thumb-sync when the thumb exists locally but is absent in R2', async () => {
    await writeOriginal();
    await writeThumb();
    await writePreview();
    const res = await evaluateAsset(
      makeAsset(),
      libs,
      slugs,
      deps({ thumbExistsInR2: async () => false }),
    );
    expect(res).toEqual(['cf-thumb-sync']);
  });

  it('does not re-arm a stage that has not reached its target version', async () => {
    await writeOriginal();
    await rm(path.join(root, 'a/b/.maple'), { recursive: true, force: true });
    const a = makeAsset();
    (a.stages as Record<string, { version: number }>).thumb.version = 0; // still queued
    const res = await evaluateAsset(a, libs, slugs, deps());
    expect(res).toEqual(['preview']); // thumb not re-armed — pipeline owns it
  });
});
