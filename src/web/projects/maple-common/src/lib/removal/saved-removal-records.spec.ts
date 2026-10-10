import { describe, expect, it } from 'vitest';
import { savedRemovalRecords } from './saved-removal-records';
const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const maple = 'http://ns.justmaple.app/photo/1.0/';
const sidecar = (descriptions: string, uri = maple) =>
  `<r:RDF xmlns:r="${rdf}" xmlns:photo="${uri}">${descriptions}</r:RDF>`;

describe('saved removal record discovery', () => {
  it('recognizes namespace aliases and both supported Maple URIs', () => {
    for (const uri of [maple, 'http://ns.justmaple.app/1.0/']) {
      expect(
        savedRemovalRecords(sidecar('<r:Description photo:InpaintRemovals="[1]"/>', uri)),
      ).toBe('[1]');
    }
    expect(
      savedRemovalRecords(
        sidecar(
          '<r:Description><photo:InpaintRemovals>[1]</photo:InpaintRemovals></r:Description>',
        ),
      ),
    ).toBe('[1]');
  });
  it('does not turn a foreign namespace into a Maple edit', () => {
    expect(
      savedRemovalRecords(sidecar('<r:Description photo:InpaintRemovals="[1]"/>', 'urn:foreign')),
    ).toBeUndefined();
    expect(
      savedRemovalRecords(sidecar('<r:Description photo:InpaintRemovals="[]"/>')),
    ).toBeUndefined();
  });
  it('rejects ambiguous siblings, malformed XML and non-array records before opening a canvas', () => {
    expect(() =>
      savedRemovalRecords(
        sidecar(
          '<r:Description photo:InpaintRemovals="[1]"/><r:Description photo:InpaintRemovals="[2]"/>',
        ),
      ),
    ).toThrow('conflicting');
    expect(() => savedRemovalRecords('<broken')).toThrow('malformed');
    expect(() =>
      savedRemovalRecords(sidecar('<r:Description photo:InpaintRemovals="{}"/>')),
    ).toThrow('record list');
  });
});
