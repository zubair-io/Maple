import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import hashStage from './hash.ts';

// Build a minimal image doc with enough fields for the handler.
function makeDoc(absPath: string) {
  return {
    _id: '000000000000000000000001' as unknown as import('mongodb').ObjectId,
    abs_path: absPath,
    stages: {
      hash: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      exif: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      thumb: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe('hash handler', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hash-stage-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a patch containing sha1_head, size, mtime, and maple_id', async () => {
    const file = path.join(dir, 'test.jpg');
    // 1 KB of deterministic bytes so sha1 is stable.
    const content = Buffer.alloc(1024, 0xab);
    await writeFile(file, content);

    const doc = makeDoc(file);
    const result = await hashStage.handler(doc as never, {} as never);

    expect('patch' in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };

    expect(typeof patch.sha1_head).toBe('string');
    expect((patch.sha1_head as string).length).toBe(40); // hex SHA-1
    expect(typeof patch.size).toBe('number');
    expect(patch.size as number).toBe(1024);
    expect(typeof patch.mtime).toBe('number');
    expect(typeof patch.maple_id).toBe('string');
    expect((patch.maple_id as string).length).toBe(32); // 16 bytes hex
  });

  it('sha1_head is deterministic for identical content', async () => {
    const fileA = path.join(dir, 'a.jpg');
    const fileB = path.join(dir, 'b.jpg');
    const content = Buffer.alloc(512, 0x77);
    await writeFile(fileA, content);
    await writeFile(fileB, content);

    const [rA, rB] = await Promise.all([
      hashStage.handler(makeDoc(fileA) as never, {} as never),
      hashStage.handler(makeDoc(fileB) as never, {} as never),
    ]);
    const pA = (rA as { patch: Record<string, unknown> }).patch;
    const pB = (rB as { patch: Record<string, unknown> }).patch;
    expect(pA.sha1_head).toBe(pB.sha1_head);
    expect(pA.maple_id).toBe(pB.maple_id);
  });

  it('throws when the file does not exist', async () => {
    const doc = makeDoc(path.join(dir, 'no-such-file.jpg'));
    await expect(hashStage.handler(doc as never, {} as never)).rejects.toThrow();
  });

  it('short-circuits with an empty patch when all hash fields are populated', async () => {
    // PR 2: discover writes maple_id + sha1_head + size + mtime inline at
    // insert time and pre-bumps stages.hash.version to the target. If the
    // stage runner ever claims such a row anyway (e.g. a folder-rescan
    // zeroes the version), the handler should detect every field is set
    // and return an empty patch — no file open, no re-hash.
    const doc = {
      ...makeDoc(path.join(dir, 'not-actually-opened.jpg')),
      maple_id: '0123456789abcdef' + '0123456789abcdef',
      sha1_head: 'a'.repeat(40),
      size: 1024,
      mtime: 1700000000000,
    };
    const result = await hashStage.handler(doc as never, {} as never);
    expect('patch' in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(patch).toEqual({});
  });

  it('re-runs the full hash when maple_id is set but sha1_head is missing', async () => {
    // Legacy backup-ingest rows had maple_id populated but never wrote
    // sha1_head (it landed pre-PR 2 hashing). The old short-circuit
    // marked stages.hash.version complete on these rows without actually
    // computing sha1_head/size/mtime, silently breaking downstream stages
    // that read those fields. The handler must detect the missing field
    // and re-derive everything.
    const file = path.join(dir, 'partial-fields.jpg');
    const content = Buffer.alloc(2048, 0x55);
    await writeFile(file, content);

    const doc = {
      ...makeDoc(file),
      // maple_id present from backup-ingest, sha1_head absent.
      maple_id: '0123456789abcdef' + '0123456789abcdef',
      // size + mtime also absent — they came from the legacy hash stage.
    };
    const result = await hashStage.handler(doc as never, {} as never);
    expect('patch' in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(typeof patch.sha1_head).toBe('string');
    expect((patch.sha1_head as string).length).toBe(40);
    expect(typeof patch.maple_id).toBe('string');
    expect((patch.maple_id as string).length).toBe(32);
    expect(patch.size as number).toBe(2048);
    expect(typeof patch.mtime).toBe('number');
  });
});
