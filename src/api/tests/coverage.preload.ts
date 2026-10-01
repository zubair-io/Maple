import { plugin } from 'bun';
import { afterAll } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoverageMapData } from 'istanbul-lib-coverage';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const sourcePattern = sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

plugin({
  name: 'maple-api-istanbul',
  setup(builder) {
    builder.onLoad(
      { filter: new RegExp(`^${sourcePattern}(?!.*\\.test\\.ts$).*\\.ts$`) },
      ({ path }) => ({
        contents: readFileSync(
          resolve('coverage', 'instrumented', path.slice(sourceRoot.length)),
          'utf8',
        ),
        loader: 'ts',
      }),
    );
  },
});

// Bun's test runner does not emit process exit hooks; the global hook saves cumulative counters after each file (#3780).
afterAll(() => {
  const coverage = (globalThis as typeof globalThis & { __coverage__?: CoverageMapData })
    .__coverage__;
  if (!coverage || Object.keys(coverage).length === 0) {
    throw new Error('API coverage instrumentation produced no counters');
  }
  const directory = resolve('coverage');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'coverage-final.json'), JSON.stringify(coverage));
});
