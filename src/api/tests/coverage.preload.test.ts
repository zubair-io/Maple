import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoverageMapData } from 'istanbul-lib-coverage';

test('the coverage preload records executed statements and leaves unused functions and branches at zero', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maple-coverage-'));
  const modulePath = fileURLToPath(new URL('../src/db/repos/assets.rows.ts', import.meta.url));
  const preload = fileURLToPath(new URL('./coverage.preload.ts', import.meta.url));
  const preparation = fileURLToPath(new URL('./coverage.instrument.ts', import.meta.url));
  const probe = join(directory, 'probe.test.ts');
  writeFileSync(
    probe,
    `import { test, expect } from 'bun:test';
     test('probe', async () => {
       const formatter = Error.prepareStackTrace;
       const limit = Error.stackTraceLimit;
       const { nullableBool } = await import(${JSON.stringify(modulePath)});
       expect(Error.prepareStackTrace).toBe(formatter);
       expect(Error.stackTraceLimit).toBe(limit);
       expect(nullableBool(null)).toBeNull();
       const { Client } = await import(${JSON.stringify(fileURLToPath(new URL('../node_modules/acme-client/src/index.js', import.meta.url)))});
       expect(typeof Client).toBe('function');
     });`,
  );
  try {
    const prepared = Bun.spawnSync({
      cmd: [process.execPath, preparation],
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exit: prepared.exitCode, stderr: prepared.stderr.toString() }).toMatchObject({
      exit: 0,
    });
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'test', '--preload', preload, probe],
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({ exit: 0 });
    const report = JSON.parse(
      readFileSync(join(directory, 'coverage', 'coverage-final.json'), 'utf8'),
    ) as CoverageMapData;
    const file = report[modulePath]!;
    expect(file.path).toBe(modulePath);
    const called = Object.entries(file.fnMap).find(([, fn]) => fn.name === 'nullableBool')!;
    const unused = Object.entries(file.fnMap).find(([, fn]) => fn.name === 'bool')!;
    expect(file.f[called[0]]).toBe(1);
    expect(file.f[unused[0]]).toBe(0);
    const statements = Object.entries(file.statementMap).filter(
      ([, statement]) =>
        statement.start.line >= called[1].loc.start.line &&
        statement.end.line <= called[1].loc.end.line,
    );
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every(([id]) => file.s[id]! > 0)).toBe(true);
    expect(Object.values(file.b).some((counts) => counts.includes(0))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
