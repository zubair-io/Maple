// What a committed white-balance sample writes, and what a rejected one says (#2434).

import { sampledWbPatch, wbSampleRejectionText } from './editor-state.wb-sample';
import { WbSampleRejected, parseWbSampleError } from '../raw-pipeline/raw-pipeline.sample-wb.types';

describe('sampledWbPatch (#2434)', () => {
  const sample = { temperature: 4820, tint: -12, algorithmVersion: 1 };

  it('writes the solved pair together with the provenance that reproduces it', () => {
    expect(sampledWbPatch(sample, 0.25, 0.75)).toEqual({
      temperature: 4820,
      tint: -12,
      wbSource: 'Sampled',
      wbSampleX: 0.25,
      wbSampleY: 0.75,
      wbAlgorithmVersion: 1,
    });
  });

  it('touches nothing but white balance — a sample is not a tone edit', () => {
    expect(Object.keys(sampledWbPatch(sample, 0.5, 0.5)).sort()).toEqual(
      ['tint', 'temperature', 'wbAlgorithmVersion', 'wbSampleX', 'wbSampleY', 'wbSource'].sort(),
    );
  });
});

describe('wbSampleRejectionText (#2434)', () => {
  it('names what to pick instead for every rejection kind', () => {
    expect(wbSampleRejectionText(new WbSampleRejected('clipped', 'x'))).toContain('darker');
    expect(wbSampleRejectionText(new WbSampleRejected('too_dark', 'x'))).toContain('brighter');
    expect(wbSampleRejectionText(new WbSampleRejected('out_of_domain', 'x'))).toContain('grey');
    expect(wbSampleRejectionText(new WbSampleRejected('outside_image', 'x'))).toContain('inside');
  });

  it('falls back to a plain message for a non-sampler failure', () => {
    expect(wbSampleRejectionText(new Error('worker unavailable'))).toBe(
      'White balance could not be sampled',
    );
  });
});

describe('parseWbSampleError (#2434)', () => {
  it('splits the WASM entry’s stable kind prefix off the message', () => {
    expect(
      parseWbSampleError('clipped: sampled surface is clipped — pick a darker neutral'),
    ).toEqual({ kind: 'clipped', message: 'sampled surface is clipped — pick a darker neutral' });
    expect(parseWbSampleError('out_of_domain: not a plausible neutral').kind).toBe('out_of_domain');
  });

  it('treats anything it does not recognise as a develop failure, message intact', () => {
    expect(parseWbSampleError('RuntimeError: unreachable')).toEqual({
      kind: 'develop',
      message: 'RuntimeError: unreachable',
    });
    expect(parseWbSampleError('')).toEqual({ kind: 'develop', message: '' });
  });
});
