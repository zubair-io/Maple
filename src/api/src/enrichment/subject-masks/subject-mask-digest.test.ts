import { describe, expect, it } from 'bun:test';
import { fnv1a64Hex, subjectMaskDigest } from './subject-mask-digest.ts';

describe('fnv1a64Hex', () => {
  it('hashes the FNV-1a 64-bit reference vectors', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex('foobar')).toBe('85944171f73967e8');
  });

  it('pads short hashes to 16 chars', () => {
    for (const input of ['', 'a', 'xy', 'a much longer input string']) {
      expect(fnv1a64Hex(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('subjectMaskDigest', () => {
  const MODEL = 'maple-server-person-instance/1';

  it('joins asset, person, skin flags and model like the Apple and web digest', () => {
    expect(subjectMaskDigest('asset-123', 0, true, true, MODEL)).toBe('1ebe481c3e3e8053');
  });

  it('names each person distinctly', () => {
    expect(subjectMaskDigest('asset-123', 1, true, true, MODEL)).toBe('4ef1d4077f6110f2');
  });

  it('changes when any recipe field changes', () => {
    const base = subjectMaskDigest('asset-123', 0, true, true, MODEL);
    const variants = [
      subjectMaskDigest('asset-124', 0, true, true, MODEL),
      subjectMaskDigest('asset-123', 0, false, true, MODEL),
      subjectMaskDigest('asset-123', 0, true, false, MODEL),
      subjectMaskDigest('asset-123', 0, true, true, 'other-model/2'),
    ];
    for (const variant of variants) {
      expect(variant).toMatch(/^[0-9a-f]{16}$/);
      expect(variant).not.toBe(base);
    }
  });
});
