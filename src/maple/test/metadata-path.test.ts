import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'bun:test';
import { maple, callNative } from '../src/index.ts';

const mapleDir = path.resolve(__dirname, '..');
const rawFixture = path.resolve(mapleDir, '../../test-fixtures/batch-transfer/source.dng');
const raw = {
  data: new Uint8Array(Array.from({ length: 24 * 16 * 3 }, (_, i) => i % 251)),
  width: 24,
  height: 16,
  channels: 3 as const,
};

async function withFile(bytes: Buffer, run: (file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-metadata-path-'));
  const file = path.join(dir, 'upload'); // Content detection must work without an extension.
  await fs.writeFile(file, bytes);
  const before = await fs.stat(file);
  try {
    await run(file);
    expect((await fs.readFile(file)).equals(bytes)).toBe(true);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('seekable path metadata (#3622)', () => {
  it.each(['jpeg', 'png', 'webp', 'tiff', 'avif'] as const)(
    '%s path matches the byte metadata, including sidecars',
    async (format) => {
      const source = maple(raw);
      if (format !== 'avif') source.withIccProfile('srgb');
      const bytes = await source
        .withMetadata({
          orientation: 6,
          ...(['jpeg', 'png'].includes(format) ? { density: 96 } : {}),
        })
        .toFormat(format)
        .toBuffer();
      await withFile(bytes, async (file) => {
        expect(await maple(file).metadata()).toEqual(await maple(bytes).metadata());
        for (const what of [['metadata'], ['stats'], ['metadata', 'stats']]) {
          const request = JSON.stringify({ v: 1, what });
          const actual = await callNative('rasterAnalyzePath', [file, request]);
          const expected = await callNative('rasterAnalyzeBuf', [bytes, request]);
          expect(actual.ok).toBe(true);
          expect(actual.json).toBe(expected.json);
        }
      });
    },
  );

  it('retries a JSON reply larger than the initial 64 KiB buffer', async () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">${'x'.repeat(100_000)}</x:xmpmeta>`;
    const bytes = await maple(raw).withXmp(xmp).png().toBuffer();
    await withFile(bytes, async (file) => {
      const actual = await maple(file).metadata();
      expect(actual.xmp?.toString()).toBe(xmp);
      expect(actual).toEqual(await maple(bytes).metadata());
    });
  });

  it('reports missing files, corrupt images, and malformed analyze requests', async () => {
    const missing = await callNative('rasterAnalyzePath', [
      '/nonexistent/maple3622.png',
      '{"v":1,"what":["metadata"]}',
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeDefined();
    await withFile(Buffer.from('not an image'), async (file) => {
      await expect(maple(file).metadata()).rejects.toThrow();
    });
    await withFile(await maple(raw).png().toBuffer(), async (file) => {
      const nul = await callNative('rasterAnalyzePath', [
        file + '\0suffix',
        '{"v":1,"what":["metadata"]}',
      ]);
      expect(nul.ok).toBe(false);
      expect(nul.error).toBeDefined();
      const bad = await callNative('rasterAnalyzePath', [file, 'broken request']);
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('request');
    });
  });

  it('metadata paths never read the full encoded input into JavaScript', async () => {
    // Separate processes guard the direct FFI and N-API paths in source and
    // shipped bundles. Direct mode also catches JS reads inside the FFI wrapper;
    // default worker dispatch is covered by the file/byte parity cases above.
    const png = await maple(raw).png().toBuffer();
    const bytes = Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]);
    await withFile(bytes, async (file) => {
      const renamedRaw = path.join(path.dirname(file), 'raw-upload');
      await fs.copyFile(rawFixture, renamedRaw);
      for (const [runtime, backend, mode, entry] of [
        ['bun', '0', 'sync', path.join(mapleDir, 'src/index.ts')],
        ['bun', '0', 'sync', path.join(mapleDir, 'dist/index.js')],
        ['bun', '1', 'worker', path.join(mapleDir, 'src/index.ts')],
        ['node', '1', 'worker', path.join(mapleDir, 'dist/index.js')],
      ]) {
        const script = `
          import fs from 'node:fs';
          import { syncBuiltinESMExports } from 'node:module';
          const targets = new Set(${JSON.stringify([file, rawFixture, renamedRaw])});
          const guard = (fn) => function(input, ...args) {
            if (targets.has(String(input))) throw new Error('Full input read in JS: ' + input);
            return fn.call(this, input, ...args);
          };
          fs.readFileSync = guard(fs.readFileSync);
          fs.readFile = guard(fs.readFile);
          fs.promises.readFile = guard(fs.promises.readFile);
          syncBuiltinESMExports();
          const { maple, setMapleExecutionMode } = await import(${JSON.stringify(entry)});
          setMapleExecutionMode(${JSON.stringify(mode)});
          const bitmap = await maple(${JSON.stringify(file)}).metadata();
          if (bitmap.width !== 24 || bitmap.size !== ${bytes.length}) throw new Error('Wrong bitmap');
          for (const path of ${JSON.stringify([rawFixture, renamedRaw])}) {
            const raw = await maple(path).metadata();
            if (!raw.isRaw || raw.format !== 'dng' || raw.hasAlpha !== undefined) throw new Error('Wrong RAW');
          }
          console.log('bounded path metadata');
        `;
        const result = spawnSync(runtime, ['--input-type=module', '-e', script], {
          cwd: mapleDir,
          encoding: 'utf-8',
          timeout: 30_000,
          env: { ...process.env, MAPLE_NAPI: backend },
        });
        expect(result.stderr, `${runtime}/${backend}`).not.toContain('Full input read in JS');
        expect(result.status, `${runtime}/${backend}: ${result.stderr}`).toBe(0);
        expect(result.stdout.trim()).toBe('bounded path metadata');
      }
    });
  });
});
