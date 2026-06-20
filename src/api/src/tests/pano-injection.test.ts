import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('Pano Flag Injection', () => {
  let tmpDir = '';
  let fakeCli = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-injection-test-'));
    fakeCli = path.join(tmpDir, 'fake-maple-cli');
    await fs.writeFile(
      fakeCli,
      `#!/bin/sh
for arg in "$@"; do
  echo "Arg: [$arg]" >> "${tmpDir}/args.txt"
done
# Extract last --out
OUT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    shift; OUT="$1"
  fi
  shift
done
if [ -n "$OUT" ]; then
  echo "PNG" > "$OUT"
fi
exit 0
`,
    );
    await fs.chmod(fakeCli, 0o755);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('Bun.spawn passes flag-like modelsDir as a literal argument (no shell injection)', async () => {
    const outputPng = path.join(tmpDir, 'normal.png');
    // Malicious modelsDir that starts with a hyphen — would be misinterpreted
    // by a shell, but Bun.spawn passes it verbatim as a single argv element.
    const maliciousModelsDir = '--version';

    const args = [
      'pano',
      'stitch',
      '--models-dir',
      maliciousModelsDir,
      '--out',
      outputPng,
      '--',
      'input1.dng',
      'input2.dng',
    ];

    const proc = Bun.spawn([fakeCli, ...args]);
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const argsWritten = await fs.readFile(path.join(tmpDir, 'args.txt'), 'utf8');
    // The fake CLI must receive --models-dir and its value as separate,
    // unchanged argv tokens — confirming no shell word-splitting occurred.
    expect(argsWritten).toContain('Arg: [--models-dir]');
    expect(argsWritten).toContain(`Arg: [${maliciousModelsDir}]`);
  });

  it('Bun.spawn rejects a binary name with embedded spaces (no shell fallback)', () => {
    // A path like "ls -la" cannot be a valid binary: Bun.spawn must throw
    // synchronously when the executable is not found — confirming no shell
    // fallback occurs that would split on the embedded space.
    expect(() => Bun.spawn(['ls -la', '.'])).toThrow();
  });

  // ── Config-layer rejection (resolveStr validation) ──────────────────────

  it('rejects relative maple_cli_path in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const resolved = resolvePanoConfig({ maple_cli_path: './maple-cli', enabled: true } as any);
    expect(resolved.maple_cli_path).toBeNull();
  });

  it('rejects hyphen-prefixed maple_cli_path in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const resolved = resolvePanoConfig({
      maple_cli_path: '--dangerous-flag',
      enabled: true,
    } as any);
    expect(resolved.maple_cli_path).toBeNull();
  });

  it('rejects relative models_dir in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const resolved = resolvePanoConfig({ models_dir: '../models', enabled: true } as any);
    expect(resolved.models_dir).toBeNull();
  });

  it('rejects hyphen-prefixed models_dir in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const resolved = resolvePanoConfig({ models_dir: '--exploit', enabled: true } as any);
    expect(resolved.models_dir).toBeNull();
  });

  it('rejects relative ort_dylib_path in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const resolved = resolvePanoConfig({ ort_dylib_path: './libonnxruntime.dylib' } as any);
    expect(resolved.ort_dylib_path).toBeNull();
  });

  it('rejects hyphen-prefixed ort_dylib_path in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const resolved = resolvePanoConfig({ ort_dylib_path: '--inject' } as any);
    expect(resolved.ort_dylib_path).toBeNull();
  });

  // ── Handler-layer rejection (parsePayload validation) ───────────────────

  it('panoStitchHandler rejects hyphen-prefixed mapleCli', async () => {
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const payload = {
      assetIds: ['60d5ecb8b3928400158c5941', '60d5ecb8b3928400158c5942'],
      libraryId: '60d5ecb8b3928400158c5940',
      outputDir: '/tmp/out',
      mapleCli: '--dangerous',
      retention: 'keep',
      localAlign: 'mesh',
      strategySupported: false,
    };
    const ctx: any = {
      reportProgress: async () => {},
      shouldCancel: async () => false,
      jobId: { toHexString: () => '123' },
    };

    await expect(panoStitchHandler.run(payload, ctx)).rejects.toThrow(
      'payload.mapleCli must be an absolute path and not start with "-"',
    );
  });

  it('panoStitchHandler rejects relative mapleCli', async () => {
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const payload = {
      assetIds: ['60d5ecb8b3928400158c5941', '60d5ecb8b3928400158c5942'],
      libraryId: '60d5ecb8b3928400158c5940',
      outputDir: '/tmp/out',
      mapleCli: './maple-cli',
      retention: 'keep',
      localAlign: 'mesh',
      strategySupported: false,
    };
    const ctx: any = {
      reportProgress: async () => {},
      shouldCancel: async () => false,
      jobId: { toHexString: () => '123' },
    };

    await expect(panoStitchHandler.run(payload, ctx)).rejects.toThrow(
      'payload.mapleCli must be an absolute path and not start with "-"',
    );
  });

  it('panoStitchHandler rejects relative modelsDir', async () => {
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const payload = {
      assetIds: ['60d5ecb8b3928400158c5941', '60d5ecb8b3928400158c5942'],
      libraryId: '60d5ecb8b3928400158c5940',
      outputDir: '/tmp/out',
      mapleCli: '/usr/bin/maple-cli',
      modelsDir: './models',
      retention: 'keep',
      localAlign: 'mesh',
      strategySupported: false,
    };
    const ctx: any = {
      reportProgress: async () => {},
      shouldCancel: async () => false,
      jobId: { toHexString: () => '123' },
    };

    await expect(panoStitchHandler.run(payload, ctx)).rejects.toThrow(
      'payload.modelsDir must be an absolute path and not start with "-"',
    );
  });

  it('panoStitchHandler rejects hyphen-prefixed modelsDir', async () => {
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const payload = {
      assetIds: ['60d5ecb8b3928400158c5941', '60d5ecb8b3928400158c5942'],
      libraryId: '60d5ecb8b3928400158c5940',
      outputDir: '/tmp/out',
      mapleCli: '/usr/bin/maple-cli',
      modelsDir: '--evil',
      retention: 'keep',
      localAlign: 'mesh',
      strategySupported: false,
    };
    const ctx: any = {
      reportProgress: async () => {},
      shouldCancel: async () => false,
      jobId: { toHexString: () => '123' },
    };

    await expect(panoStitchHandler.run(payload, ctx)).rejects.toThrow(
      'payload.modelsDir must be an absolute path and not start with "-"',
    );
  });

  it('panoStitchHandler rejects relative ortDylibPath', async () => {
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const payload = {
      assetIds: ['60d5ecb8b3928400158c5941', '60d5ecb8b3928400158c5942'],
      libraryId: '60d5ecb8b3928400158c5940',
      outputDir: '/tmp/out',
      mapleCli: '/usr/bin/maple-cli',
      ortDylibPath: '../libonnxruntime.dylib',
      retention: 'keep',
      localAlign: 'mesh',
      strategySupported: false,
    };
    const ctx: any = {
      reportProgress: async () => {},
      shouldCancel: async () => false,
      jobId: { toHexString: () => '123' },
    };

    await expect(panoStitchHandler.run(payload, ctx)).rejects.toThrow(
      'payload.ortDylibPath must be an absolute path and not start with "-"',
    );
  });

  it('panoStitchHandler rejects hyphen-prefixed ortDylibPath', async () => {
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const payload = {
      assetIds: ['60d5ecb8b3928400158c5941', '60d5ecb8b3928400158c5942'],
      libraryId: '60d5ecb8b3928400158c5940',
      outputDir: '/tmp/out',
      mapleCli: '/usr/bin/maple-cli',
      ortDylibPath: '--inject-flag',
      retention: 'keep',
      localAlign: 'mesh',
      strategySupported: false,
    };
    const ctx: any = {
      reportProgress: async () => {},
      shouldCancel: async () => false,
      jobId: { toHexString: () => '123' },
    };

    await expect(panoStitchHandler.run(payload, ctx)).rejects.toThrow(
      'payload.ortDylibPath must be an absolute path and not start with "-"',
    );
  });
});
