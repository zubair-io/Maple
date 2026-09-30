import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessWorker, childScriptPath } from '../runtime/child-process-worker.ts';
import { solidAvif } from '../test-support/synth-image.ts';
import { nativeLibAvailable } from './raw_ffi.ts';
import type { ValidateAvifResponse } from './raw_ffi-protocol.ts';

const CHILD = childScriptPath(import.meta.url, './raw_ffi.child.ts');

// The API CI job builds this library before running the suite. Local runs
// without a native build follow the other fixture-gated decode tests.
describe.skipIf(!nativeLibAvailable())('FFI child — decode-only AVIF integrity', () => {
  it('accepts complete pixels and preserves a corrupt-frame decoder reason over IPC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'child-integrity-'));
    const worker = new ChildProcessWorker(CHILD, { label: 'integrity-test' });
    try {
      const full = await solidAvif(120, 80, [200, 100, 50]);
      const mdat = full.indexOf('mdat');
      expect(mdat).toBeGreaterThan(4);
      const boxSize = full.readUInt32BE(mdat - 4);
      const corrupt = Buffer.from(full);
      // Keep the sequence header so metadata still succeeds; damage pixels.
      corrupt.fill(0, mdat + 4 + 8, mdat - 4 + boxSize);
      const goodPath = join(dir, 'good.avif');
      const badPath = join(dir, 'bad.avif');
      await writeFile(goodPath, full);
      await writeFile(badPath, corrupt);

      const validate = (filePath: string, id: number): Promise<ValidateAvifResponse> =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('integrity IPC timeout')), 15000);
          worker.addEventListener('message', ({ data }) => {
            clearTimeout(timeout);
            resolve(data as ValidateAvifResponse);
          });
          worker.addEventListener('error', ({ message }) => {
            clearTimeout(timeout);
            reject(new Error(message));
          });
          worker.postMessage({ type: 'validateAvif', id, filePath, expectedLongEdgePx: 256 });
        });

      expect(await validate(goodPath, 1)).toEqual({ type: 'validateAvif', id: 1, ok: true });
      const result = await validate(badPath, 2);
      expect(result.type).toBe('validateAvif');
      expect(result.id).toBe(2);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^pixel decode failed: .+/);
      expect(result.reason).not.toContain('unknown analyze request');
    } finally {
      worker.terminate();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
