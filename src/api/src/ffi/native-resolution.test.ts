/** #3529: the availability gate and actual loader must share Maple's resolver. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { findNativeLib, nativeLibFilename } from 'maple';

const apiRoot = path.resolve(import.meta.dir, '../..');
const library = findNativeLib();

if (!library) console.warn('native resolution integration: no native library, skipping');

test.skipIf(!library)(
  'an external native binary serves pooled bitmap work without the API-native path',
  async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'maple-native-resolution-'));
    try {
      const redirected = path.join(dir, nativeLibFilename());
      await fs.symlink(library!, redirected);
      const legacyPath = path.join(apiRoot, 'native', nativeLibFilename());
      const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { maple, shutdownMaplePool } from 'maple';
      import { nativeLibAvailable, nativeLibPath, tryGetRawFfi } from './src/ffi/raw_ffi.ts';
      import { ffiPool } from './src/ffi/ffi-pool.ts';
      const originalExists = fs.existsSync;
      fs.existsSync = (file) => String(file) !== ${JSON.stringify(legacyPath)} && originalExists(file);
      syncBuiltinESMExports();
      const source = ${JSON.stringify(path.join(dir, 'input.png'))};
      const output = ${JSON.stringify(path.join(dir, 'output.avif'))};
      const bytes = await maple({ data: new Uint8Array(24 * 16 * 3).fill(128),
        width: 24, height: 16, channels: 3 }).png().toBuffer();
      await fs.promises.writeFile(source, bytes);
      const before = fs.statSync(source).mtimeMs;
      const pool = ffiPool();
      pool.setPoolSize(1);
      try {
        const raw = tryGetRawFfi();
        const result = await pool.renderBitmapThumbToFile(source, output, 24, 70, 'png');
        const meta = await maple(output).metadata();
        console.log('MAPLE_RESOLUTION_TEST ' + JSON.stringify({
          available: nativeLibAvailable(), legacyExists: fs.existsSync(${JSON.stringify(legacyPath)}),
          path: nativeLibPath(), loaded: raw !== null, filename: raw?.validateFilename('photo.jpg'),
          result, width: meta.width, height: meta.height,
          unchanged: fs.readFileSync(source).equals(bytes) && fs.statSync(source).mtimeMs === before,
        }));
      } finally { pool.shutdown(); shutdownMaplePool(); }
    `;
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: apiRoot,
        env: { ...process.env, MAPLE_NATIVE_LIB: redirected, MAPLE_NAPI: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit, stderr).toBe(0);
      const line = stdout.split('\n').find((s) => s.startsWith('MAPLE_RESOLUTION_TEST '));
      expect(line, stdout + stderr).toBeDefined();
      const result = JSON.parse(line!.slice('MAPLE_RESOLUTION_TEST '.length));
      expect(result).toMatchObject({
        available: true,
        legacyExists: false,
        path: redirected,
        loaded: true,
        filename: { ok: true },
        result: { ok: true },
        width: 24,
        height: 16,
        unchanged: true,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
