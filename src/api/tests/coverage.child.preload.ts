// Instrument a real API entry process for the auth-expiry boot regression.
// The output path is supplied as an argument, never an operator setting.
import { plugin } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const sourcePattern = sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

plugin({
  name: 'maple-api-boot-istanbul',
  setup(builder) {
    builder.onLoad(
      { filter: new RegExp(`^${sourcePattern}(?!.*\\.(?:test|d)\\.ts$).*\\.ts$`) },
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

process.on('exit', () => {
  const coverage = (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__;
  writeFileSync(process.argv[2]!, JSON.stringify(coverage));
});
