import { describe, it, expect } from 'bun:test';
import { COLOR_LABELS, VALID_COLOR_LABELS } from './color-label.ts';
import fs from '../fs/mirrored.ts';
import os from 'node:os';
import path from 'node:path';
import { mergeMetadataIntoXmp } from './metadata-serializer.ts';
import { parseXmpMetadata } from './metadata-parser.ts';

describe('color-label vocabulary (#1657)', () => {
  it('is the canonical six-color set', () => {
    expect(COLOR_LABELS).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
  });

  it('VALID_COLOR_LABELS has one entry per COLOR_LABELS member', () => {
    expect(VALID_COLOR_LABELS.size).toBe(COLOR_LABELS.length);
    for (const c of COLOR_LABELS) expect(VALID_COLOR_LABELS.has(c)).toBe(true);
  });

  it('accepts every canonical color, including orange and purple', () => {
    for (const c of COLOR_LABELS) expect(VALID_COLOR_LABELS.has(c)).toBe(true);
  });

  it('rejects anything outside the vocabulary (case-sensitive, no empty string)', () => {
    for (const bad of ['magenta', 'Red', '', 'RED']) {
      expect(VALID_COLOR_LABELS.has(bad)).toBe(false);
    }
  });
});

it('every generated color survives a real sidecar file round-trip', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-color-labels-'));
  try {
    for (const colorLabel of COLOR_LABELS) {
      const file = path.join(directory, `${colorLabel}.xmp`);
      await fs.writeFile(file, mergeMetadataIntoXmp('', { colorLabel }));
      expect(parseXmpMetadata(await fs.readFile(file, 'utf8')).colorLabel).toBe(colorLabel);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
