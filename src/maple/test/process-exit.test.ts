import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const mapleDir = path.resolve(__dirname, '..');

describe('process exits cleanly after worker-pool use', () => {
  it('a script that calls callNative and does nothing else exits on its own, without an explicit shutdown', () => {
    const script = `
      import { callNative } from '${path.join(mapleDir, 'src/index.ts')}';
      const result = await callNative('validateFilename', ['ok.jpg']);
      console.log(JSON.stringify(result));
    `;
    const res = spawnSync('bun', ['-e', script], {
      cwd: mapleDir,
      timeout: 10_000,
      encoding: 'utf-8',
    });
    expect(res.signal).toBeNull(); // null signal = it exited on its own, not killed by our timeout
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('{"ok":true}');
  });
});
