// manifest-file-handlers.spec.ts — drift guard for the PWA `file_handlers`
// registration (#2798).
//
// The manifest is static JSON and can't import the TS extension list, so
// nothing but this spec stops the two from drifting apart: registering an
// extension `isSupportedRaw` rejects would deliver files the import path
// silently drops, and missing one would keep Maple out of the OS "Open
// with" menu for a format it can open.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SUPPORTED_RAW_EXTENSIONS } from '@maple-common';

interface FileHandlerEntry {
  action: string;
  accept: Record<string, string[]>;
}

/** The spec is bundled (import.meta.url isn't a file: URL, and esbuild has
 * no .webmanifest loader), so resolve the manifest from the runner's cwd —
 * `ng test` runs from src/web; walking up also covers a repo-root cwd. */
function readManifest(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'projects/maple/src/manifest.webmanifest');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const srcWeb = join(dir, 'src/web/projects/maple/src/manifest.webmanifest');
    if (existsSync(srcWeb)) return readFileSync(srcWeb, 'utf8');
    dir = dirname(dir);
  }
  throw new Error(`manifest.webmanifest not found walking up from ${process.cwd()}`);
}

const manifest = JSON.parse(readManifest()) as { file_handlers?: FileHandlerEntry[] };

describe('manifest.webmanifest file_handlers', () => {
  it('declares exactly one handler pointing at /open-file', () => {
    expect(manifest.file_handlers).toHaveLength(1);
    expect(manifest.file_handlers![0].action).toBe('/open-file');
  });

  it('registers exactly the extensions isSupportedRaw accepts', () => {
    const registered = Object.values(manifest.file_handlers![0].accept)
      .flat()
      .map((ext) => ext.replace(/^\./, '').toLowerCase())
      .sort();
    const supported = [...SUPPORTED_RAW_EXTENSIONS].sort();
    expect(registered).toEqual(supported);
  });

  it('every accept key is an image/* MIME type with dot-prefixed extensions', () => {
    for (const [mime, exts] of Object.entries(manifest.file_handlers![0].accept)) {
      expect(mime).toMatch(/^image\//);
      for (const ext of exts) expect(ext).toMatch(/^\.[a-z0-9]+$/);
    }
  });
});
