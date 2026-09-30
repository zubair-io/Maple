import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';

async function isolatedOracle(required: boolean, broken = false) {
  const dir = await mkdtemp(join(tmpdir(), 'maple-oracle-'));
  try {
    await mkdir(join(dir, 'node_modules'));
    const helper = join(dir, 'sharp-oracle.ts');
    await writeFile(helper, await readFile(new URL('./support/sharp-oracle.ts', import.meta.url)));
    if (broken) {
      const packageDir = join(dir, 'node_modules/sharp');
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'index.js'), 'throw new Error("broken libvips binary");');
    }
    const run = Bun.spawnSync(
      [
        process.execPath,
        '--no-install',
        '-e',
        `const {loadSharpOracle} = await import(${JSON.stringify(pathToFileURL(helper).href)});
       if (loadSharpOracle() === null) console.log('oracle absent');`,
      ],
      {
        cwd: dir,
        env: { ...process.env, MAPLE_ORACLE_REQUIRED: required ? '1' : '0' },
      },
    );
    return {
      code: run.exitCode,
      stdout: run.stdout.toString(),
      stderr: run.stderr.toString(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Oracle availability gate (#3587)', () => {
  it('fails a required run when the oracle dependency is missing', async () => {
    const result = await isolatedOracle(true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Sharp oracle unavailable');
  });

  it('allows an explicit local skip when the dependency is absent', async () => {
    const result = await isolatedOracle(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('oracle absent');
    expect(result.stderr).toContain('Cross-decoder tests will skip');
  });

  it('fails even an optional local run when an installed oracle is broken', async () => {
    const result = await isolatedOracle(false, true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('broken libvips binary');
  });
});
