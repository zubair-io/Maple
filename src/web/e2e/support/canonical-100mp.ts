import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Reuse the committed, measured fixture identity rather than trusting whichever
// bytes currently occupy the gitignored canonical filename.
export async function canonical100mpIdentity(source: string) {
  const expected = JSON.parse(
    await readFile(
      resolve(__dirname, '../../../../test-fixtures/qualification/browser-100mp-3669.json'),
      'utf8',
    ),
  ) as { fixture: string; bytes: number; sha256: string };
  const bytes = (await stat(source)).size;
  if (bytes !== expected.bytes) {
    throw new Error(
      `${expected.fixture}: expected canonical ${expected.bytes} bytes, got ${bytes}`,
    );
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (sha256 !== expected.sha256) {
    throw new Error(
      `${expected.fixture}: source SHA-256 does not match the committed canonical identity`,
    );
  }
  return { bytes, sha256 };
}
