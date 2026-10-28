import { describe, expect, test } from 'bun:test';
import { panoOutputLocation, type PanoOutputIdentity } from './pano-output-location.ts';

const identity: PanoOutputIdentity = {
  assetIds: ['b', 'a'],
  inputStamps: ['10:1', '20:2'],
  retention: 'keep',
  localAlign: 'mesh',
  strategy: null,
  matcher: 'classical',
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
    ];
    for (const change of variants) {
      expect(place(['/lib/a.dng'], { ...identity, ...change }).filename).not.toBe(base);
    }
  });
});
