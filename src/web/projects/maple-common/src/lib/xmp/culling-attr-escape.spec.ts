// culling-attr-escape.spec.ts — `papp:Flag` / `papp:ColorLabel` are XML-escaped (#3247).
//
// `cullingParts()` accepts a plain `string` fallback beyond the `XmpFlag` /
// `ColorLabelValue` unions, so a value carrying `"`, `&` or `<` used to be
// interpolated raw into the attribute and produced a sidecar no XML parser
// would accept. Every other attribute in the serializer already goes through
// `escapeXmpAttr`; these cases pin the two culling attributes to the same
// rule: the document stays well-formed and the raw value survives a DOM
// round-trip byte-for-byte.
//
// The typed culling parser (`parseCulling`) deliberately maps unknown flag /
// label words back to `unflagged` / `null`, so "survives" is asserted at the
// XML layer — the attribute value the DOM hands back — not on the enum.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { cullingParts, escapeXmpAttr } from './xmp-serializer-parts';
import { hasXmlParseError } from './xmp-dom-utils';
import type { XmpCulling } from './xmp.types';

const HOSTILE = 'pi"ck&<x>';

function defaultCulling(): XmpCulling {
  return { rating: 0, flag: 'unflagged', colorLabel: null, keywords: [] };
}

/** Parse strictly and return the `rdf:Description` element, failing on any parser error. */
function descriptionOf(xml: string): Element {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(hasXmlParseError(doc)).toBe(false);
  expect(doc.querySelector('parsererror, parseerror')).toBeNull();
  const desc = doc.getElementsByTagNameNS(
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'Description',
  )[0];
  expect(desc).toBeDefined();
  return desc;
}

describe('cullingParts escapes papp:Flag and papp:ColorLabel', () => {
  it('flag goes through escapeXmpAttr', () => {
    const parts = cullingParts({ flag: HOSTILE });
    expect(parts).toEqual([`papp:Flag="${escapeXmpAttr(HOSTILE)}"`]);
    expect(parts[0]).not.toContain(HOSTILE);
  });

  it('colorLabel goes through escapeXmpAttr', () => {
    const parts = cullingParts({ colorLabel: HOSTILE });
    expect(parts).toEqual([`papp:ColorLabel="${escapeXmpAttr(HOSTILE)}"`]);
    expect(parts[0]).not.toContain(HOSTILE);
  });
});

describe('hostile culling values survive a serialize → DOM round-trip', () => {
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('papp:Flag with a quote, ampersand and angle brackets keeps the sidecar well-formed', () => {
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, {
      ...defaultCulling(),
      flag: HOSTILE as XmpCulling['flag'],
    });
    const desc = descriptionOf(xml);
    expect(desc.getAttribute('papp:Flag')).toBe(HOSTILE);
  });

  it('papp:ColorLabel with a quote, ampersand and angle brackets keeps the sidecar well-formed', () => {
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, {
      ...defaultCulling(),
      colorLabel: HOSTILE as XmpCulling['colorLabel'],
    });
    const desc = descriptionOf(xml);
    expect(desc.getAttribute('papp:ColorLabel')).toBe(HOSTILE);
  });

  it('plain enum values are emitted unchanged', () => {
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, {
      ...defaultCulling(),
      flag: 'pick',
      colorLabel: 'red',
    });
    expect(xml).toContain('papp:Flag="pick"');
    expect(xml).toContain('papp:ColorLabel="red"');
  });
});
