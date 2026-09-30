import { expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { NativeBindingError, isNativeBindingError, maple } from '../src/index';

const packageRoot = path.resolve(import.meta.dir, '..');

async function probe(entry: string, mode: 'sync' | 'worker', cwd: string, lib: string) {
  const pixels = await maple({
    data: Uint8Array.from({ length: 12 }, (_, i) => [128, 96, 64][i % 3]),
    width: 2,
    height: 2,
    channels: 3,
  })
    .png()
    .toBuffer();
  const script = `
    import { maple, isNativeBindingError, setMapleExecutionMode, shutdownMaplePool } from ${JSON.stringify(entry)};
    setMapleExecutionMode(${JSON.stringify(mode)});
    try {
      await maple(Buffer.from(${JSON.stringify(pixels.toString('base64'))}, 'base64')).toRaw();
      throw new Error('unexpected successful decode');
    } catch (error) {
      console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message,
        classified: isNativeBindingError(error) }));
    } finally { shutdownMaplePool(); }
  `;
  const proc = Bun.spawn([process.execPath, '-e', script], {
    cwd,
    env: { ...process.env, MAPLE_NAPI: '0', MAPLE_NATIVE_LIB: lib },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout.trim()) as {
    name: string;
    code?: string;
    message: string;
    classified: boolean;
  };
}

test('bad native libraries retain backend-error identity in source and built worker/sync modes', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'maple-native-errors-'));
  try {
    const lib = path.join(dir, 'invalid-native-library');
    await fs.writeFile(lib, 'deliberately invalid shared library');
    for (const entry of ['src/index.ts', 'dist/index.js']) {
      for (const mode of ['sync', 'worker'] as const) {
        const error = await probe(path.join(packageRoot, entry), mode, dir, lib);
        expect(error.name).toBe('NativeBindingError');
        expect(error.code).toBe('MAPLE_NATIVE_BINDING');
        expect(error.classified).toBe(true);
        expect(error.message).toContain(lib);
        expect(error.message).toContain('could not be loaded');
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an installed bundle with no native binary reports a typed error in both modes', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'maple-no-native-'));
  try {
    // A real built bundle in an empty install tree: no monorepo binary or
    // installed platform package can satisfy its resolver.
    const entry = path.join(dir, 'package', 'dist', 'index.js');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.copyFile(path.join(packageRoot, 'dist/index.js'), entry);
    for (const mode of ['sync', 'worker'] as const) {
      // The pool's companion bundle must exist even when no native lib does.
      await fs.copyFile(
        path.join(packageRoot, 'dist/native-worker-entry.js'),
        path.join(path.dirname(entry), 'native-worker-entry.js'),
      );
      const error = await probe(entry, mode, dir, '');
      expect(error.name).toBe('NativeBindingError');
      expect(error.code).toBe('MAPLE_NATIVE_BINDING');
      expect(error.classified).toBe(true);
      expect(error.message).toContain('not found');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('corrupt input bytes remain an image error when the native backend works', async () => {
  let caught: unknown;
  try {
    await maple(Buffer.from('invalid image')).toRaw();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(isNativeBindingError(caught)).toBe(false);
});

test('backend error codes work across package copies while ordinary errors stay unclassified', () => {
  const cause = new Error('wrong architecture');
  const error = new NativeBindingError('cannot load library', { cause });
  expect(error.cause).toBe(cause);
  expect(isNativeBindingError(error)).toBe(true);
  expect(isNativeBindingError(Object.assign(new Error('another copy'), { code: error.code }))).toBe(
    true,
  );
  expect(isNativeBindingError(new Error('corrupt JPEG'))).toBe(false);
  expect(isNativeBindingError({ code: error.code })).toBe(false);
});
