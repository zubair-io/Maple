/**
 * Measure the JPEG file-size gap between Maple's pure-Rust `jpeg-encoder` path
 * and mozjpeg (through sharp), at matched quality settings.
 *
 * This is EVIDENCE, not a gate: decision D7 of the Tier 2 plan is that the gap
 * is measured and documented rather than closed, because closing it needs a C
 * dependency and the Linux zero-dependency linkage audit forbids one.
 *
 * Run from `src/maple`:
 *   bun run scripts/bench-jpeg-size.ts /path/to/photo.jpg [more.jpg ...]
 *
 * sharp is not a dependency of this package; the script resolves it from
 * `src/api/node_modules` and skips the comparison column when it is absent.
 */

import * as fs from 'node:fs/promises';
import { maple } from '../src/index';

const QUALITIES = [60, 75, 82, 90];

async function loadSharp(): Promise<((input: Buffer) => unknown) | null> {
  try {
    const mod = await import('../../api/node_modules/sharp/lib/index.js');
    return (mod as { default: (input: Buffer) => unknown }).default;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: bun run scripts/bench-jpeg-size.ts <image> [image ...]');
    process.exitCode = 1;
    return;
  }
  const sharp = await loadSharp();
  if (!sharp) {
    console.log('sharp not found (src/api/node_modules) — reporting Maple sizes only.\n');
  }
  console.log('file\tquality\tmaple\tmozjpeg\tdelta');
  for (const file of files) {
    const input = await fs.readFile(file);
    for (const quality of QUALITIES) {
      const mine = await maple(input).jpeg({ quality, optimiseCoding: true }).toBuffer();
      const theirs = sharp
        ? await (sharp(input) as { jpeg: (o: unknown) => { toBuffer: () => Promise<Buffer> } })
            .jpeg({ quality, mozjpeg: true })
            .toBuffer()
        : null;
      const delta = theirs
        ? `${(((mine.length - theirs.length) / theirs.length) * 100).toFixed(1)}%`
        : '—';
      console.log(`${file}\t${quality}\t${mine.length}\t${theirs ? theirs.length : '—'}\t${delta}`);
    }
  }
}

await main();
