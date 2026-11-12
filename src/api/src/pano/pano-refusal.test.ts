import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from '../fs/mirrored.ts';
import os from 'node:os';
import path from 'node:path';
import { parseRefusal, readRefusal, refusalMessage } from './pano-refusal.ts';

let tmpDir = '';

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-refusal-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function report(name: string, body: string): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, body);
  return file;
}

describe('readRefusal', () => {
  it('reads the block maple-cli writes for a memory refusal', async () => {
    const file = await report(
      'memory.json',
      '{\n  "refused": {\n    "available_bytes": 2147483648,\n    "needed_bytes": 3196551170,\n    "reason": "memory"\n  }\n}',
    );

    expect(await readRefusal(file)).toEqual({
      reason: 'memory',
      neededBytes: 3196551170,
      availableBytes: 2147483648,
    });
  });

  it('reads a scratch-space refusal', async () => {
    const file = await report(
      'scratch.json',
      '{"refused":{"reason":"scratch_space","needed_bytes":5245091712,"available_bytes":1048576}}',
    );

    expect(await readRefusal(file)).toEqual({
      reason: 'scratch_space',
      neededBytes: 5245091712,
      availableBytes: 1048576,
    });
  });

  it('is null for a finished stitch, a missing report and a report that is not JSON', async () => {
    const done = await report('done.json', '{"width":2047,"alignment":{"status":"solved"}}');
    const torn = await report('torn.json', '{"refused":');

    expect(await readRefusal(done)).toBeNull();
    expect(await readRefusal(path.join(tmpDir, 'absent.json'))).toBeNull();
    expect(await readRefusal(torn)).toBeNull();
  });
});

describe('parseRefusal', () => {
  it('ignores a block it cannot act on', () => {
    expect(parseRefusal({ refused: null })).toBeNull();
    expect(parseRefusal({ refused: 'memory' })).toBeNull();
    expect(parseRefusal({ refused: { reason: 'memory' } })).toBeNull();
    expect(
      parseRefusal({ refused: { reason: 'weather', needed_bytes: 1, available_bytes: 1 } }),
    ).toBeNull();
    expect(
      parseRefusal({ refused: { reason: 'memory', needed_bytes: '3', available_bytes: 1 } }),
    ).toBeNull();
    expect(
      parseRefusal({ refused: { reason: 'memory', needed_bytes: -1, available_bytes: 1 } }),
    ).toBeNull();
  });
});

describe('refusalMessage', () => {
  it('names the setting an owner can change for memory', () => {
    expect(
      refusalMessage({
        reason: 'memory',
        neededBytes: 3_196_551_170,
        availableBytes: 2 * 1024 ** 3,
      }),
    ).toBe(
      'This panorama needs about 3.2 GB of memory to merge, and the server allows 2.1 GB. ' +
        'Merge fewer photos, or ask the server’s owner to raise “Decode memory budget” in Settings → Workers.',
    );
  });

  it('never prints the need and the allowance as the same figure', () => {
    const text = refusalMessage({
      reason: 'memory',
      neededBytes: 3_000_000_001,
      availableBytes: 3_000_000_000,
    });

    expect(text).toContain('needs about 3.1 GB of memory');
    expect(text).toContain('the server allows 3.0 GB');
  });

  it('carries no path, exit code or ticket number', () => {
    const texts = (['memory', 'scratch_space'] as const).map((reason) =>
      refusalMessage({ reason, neededBytes: 5e9, availableBytes: 1e9 }),
    );

    expect(texts.every((text) => !/[/#]|\bexit\b|maple-cli/.test(text))).toBe(true);
  });
});
