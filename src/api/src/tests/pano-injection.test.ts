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

  it('demonstrates flag injection via modelsDir', async () => {
    const outputPng = path.join(tmpDir, 'normal.png');
    const injectedPng = path.join(tmpDir, 'injected.png');

    // Malicious modelsDir that starts with a hyphen
    const maliciousModelsDir = `--version`;

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
    await proc.exited;

    const argsWritten = await fs.readFile(path.join(tmpDir, 'args.txt'), 'utf8');
    console.log('Spawned with args:\n' + argsWritten);

    expect(argsWritten).toContain(`Arg: [--models-dir]`);
    expect(argsWritten).toContain(`Arg: [${maliciousModelsDir}]`);

    // If maple-cli (the real one) uses clap, and we pass --models-dir --version,
    // clap will see --version as the value for --models-dir.
    // BUT if we pass something like:
    const maliciousModelsDir2 = `-V`;
    const args2 = [
      'pano',
      'stitch',
      '--models-dir', // this expects a value
      maliciousModelsDir2, // clap might take this as the value
      '--out',
      outputPng,
      '--',
      'input1.dng',
      'input2.dng',
    ];
    // This is generally safe because Bun.spawn doesn't use a shell.

    // The REAL risk is when we don't use -- before positional arguments,
    // but we ARE using -- in pano-stitch.ts.

    // What if the operator sets mapleCli to a path that contains spaces and flags?
    // In routes/pano.ts:
    // const proc = Bun.spawn([cliPath, 'pano', 'stitch', '--help']
    // If cliPath is "maple-cli --some-dangerous-flag", Bun.spawn will fail
    // unless it's a single file.

    try {
      await Bun.spawn(['ls -la', '.']).exited;
    } catch (e) {
      console.log('Bun.spawn(["ls -la", "."]) failed as expected');
    }
  });

  it('rejects relative paths in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const dbVal = {
      maple_cli_path: './maple-cli',
      enabled: true,
    };
    const resolved = resolvePanoConfig(dbVal as any);
    expect(resolved.maple_cli_path).toBeNull();
  });

  it('rejects hyphen-prefixed paths in configuration', async () => {
    const { resolvePanoConfig } = await import('../pano/pano-config.repo.ts');
    const dbVal = {
      maple_cli_path: '--dangerous-flag',
      enabled: true,
    };
    const resolved = resolvePanoConfig(dbVal as any);
    expect(resolved.maple_cli_path).toBeNull();
  });

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

    // We expect parsePayload to throw. parsePayload is internal but called by run().
    // We can't easily call parsePayload directly, so we call run().
    // We need a mock context.
    const ctx: any = {
      reportProgress: async () => {},
      shouldCancel: async () => false,
      jobId: { toHexString: () => '123' },
    };

    try {
      await panoStitchHandler.run(payload, ctx);
      expect(true).toBe(false); // should not reach here
    } catch (e: any) {
      expect(e.message).toContain(
        'payload.mapleCli must be an absolute path and not start with "-"',
      );
    }
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

    try {
      await panoStitchHandler.run(payload, ctx);
      expect(true).toBe(false); // should not reach here
    } catch (e: any) {
      expect(e.message).toContain(
        'payload.modelsDir must be an absolute path and not start with "-"',
      );
    }
  });
});
