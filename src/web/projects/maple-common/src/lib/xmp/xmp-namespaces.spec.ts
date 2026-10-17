import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasXmlParseError } from './xmp-dom-utils';
import { XmpParserService } from './xmp-parser.service';

const parser = new XmpParserService();
// Written by Apple's XMPSidecarStore from lightroom-foreign-attributes.xmp;
// XMPPassthroughNamespaceTests keeps it byte-identical to Apple's output (#4688).
const appleResaved = readFileSync(
  resolve('../../test-fixtures/xmp-namespaces', 'apple-resaved.xmp'),
  'utf8',
);

describe('Apple-resaved Lightroom sidecar (#4688)', () => {
  it('is namespace-well-formed for the browser parser', () => {
    const doc = new DOMParser().parseFromString(appleResaved, 'text/xml');
    expect(hasXmlParseError(doc)).toBe(false);
  });

  it('keeps the rating and develop settings readable', () => {
    expect(parser.parseCulling(appleResaved).rating).toBe(4);
    const { model, passthrough } = parser.parseAdjustmentModel(appleResaved);
    expect(model.exposure).toBe(1.25);
    expect(model.contrast).toBe(12);
    const preserved = passthrough.unknownAttributes.map((attribute) => attribute.name);
    expect(preserved).toEqual(
      expect.arrayContaining(['photoshop:DateCreated', 'exif:ExposureTime', 'dc:format']),
    );
  });
});
