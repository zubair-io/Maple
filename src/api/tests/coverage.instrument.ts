import { Glob } from 'bun';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstrumenter } from 'istanbul-lib-instrument';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const instrumenter = createInstrumenter({
  esModules: true,
  parserPlugins: ['typescript'],
  compact: false,
});

// Babel's stack formatter breaks Bun's Error subclasses, so instrumentation runs before the test process (#3780).
for (const relativePath of new Glob('**/*.ts').scanSync(sourceRoot)) {
  if (relativePath.endsWith('.test.ts') || relativePath.endsWith('.d.ts')) continue;
  const source = resolve(sourceRoot, relativePath);
  const output = resolve('coverage', 'instrumented', relativePath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, instrumenter.instrumentSync(readFileSync(source, 'utf8'), source));
}
