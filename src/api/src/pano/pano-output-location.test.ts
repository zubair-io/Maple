import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { panoOutputLocation, type PanoOutputIdentity } from './pano-output-location.ts';

const identity: PanoOutputIdentity = {
  assetIds: ['b', 'a'],
  inputStamps: ['10:1', '20:2'],
  retention: 'keep',
  localAlign: 'mesh',
  strategy: null,
  matcher: 'classical',
  boundaryWarp: 0,
  autoCrop: false,
};

const place = (inputs: string[], id: PanoOutputIdentity = identity) =>
  panoOutputLocation('/lib', inputs, id);

describe('panoOutputLocation (#5488)', () => {
  test('lands in a Panoramas folder beside the first frame', () => {
    const at = place(['/lib/trip/a.dng', '/lib/trip/b.dng']);
    expect(at.relDir).toBe('trip/Panoramas');
    expect(at.absPath).toBe(`/lib/trip/Panoramas/${at.filename}`);
    expect(at.filename).toMatch(/^a-pano-[0-9a-f]{8}\.png$/);
  });

  test('a frame outside the library puts the result at the library root', () => {
    const at = place(['/elsewhere/a.dng']);
    expect(at.relDir).toBe('Panoramas');
    expect(at.absPath.startsWith('/lib/Panoramas/')).toBe(true);
  });

  test('a folder whose name starts with two dots is still inside the library', () => {
    expect(place(['/lib/..trip/a.dng']).relDir).toBe('..trip/Panoramas');
  });

  test('frame order does not change the name', () => {
    const reordered = { ...identity, assetIds: ['a', 'b'], inputStamps: ['20:2', '10:1'] };
    expect(place(['/lib/a.dng'], reordered).filename).toBe(place(['/lib/a.dng']).filename);
  });

  test('every option and a replaced source file change the name', () => {
    const base = place(['/lib/a.dng']).filename;
    const variants: Partial<PanoOutputIdentity>[] = [
      { inputStamps: ['10:1', '20:3'] },
      { retention: 'strict' },
      { localAlign: 'off' },
      { strategy: 'tile' },
      { matcher: 'ml' },
      { boundaryWarp: 40 },
      { autoCrop: true },
    ];
    for (const change of variants) {
      expect(place(['/lib/a.dng'], { ...identity, ...change }).filename).not.toBe(base);
    }
  });

  test('the unwarped, uncropped default keeps the name an earlier run gave it', () => {
    const legacy = createHash('sha256')
      .update(JSON.stringify([['a', 'b'], ['10:1', '20:2'], 'keep', 'mesh', null, 'classical']))
      .digest('hex')
      .slice(0, 8);
    expect(place(['/lib/a.dng']).filename).toBe(`a-pano-${legacy}.png`);
  });
});
