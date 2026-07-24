// color-label.spec.ts — canonical color-label vocabulary round-trip (#1657).
//
// Before this ticket, the batch/XMP path (this parser/serializer pair)
// recognised `red | orange | yellow | green | blue` but not `purple`, while
// search recognised `red | yellow | green | blue | purple` but not
// `orange`. The canonical vocabulary is now the six-value union
// (`COLOR_LABEL_VALUES` in `../models/color-label`), single-sourced and
// imported everywhere instead of hard-coded.
//
// This also covers a real bug found while fixing #1657: `LABEL_MAP` in
// `xmp-parser.service.ts` (the table that reads the XMP-standard
// `xmp:Label` word — the attribute Adobe Lightroom/Bridge write for their
// label colors) was missing `Purple` entirely, so a Lightroom-authored
// `xmp:Label="Purple"` silently parsed to no color label at all.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { COLOR_LABEL_VALUES, isColorLabelValue } from '../models/color-label';
import type { XmpCulling } from './xmp.types';

function defaultCulling(): XmpCulling {
  return { rating: 0, flag: 'unflagged', colorLabel: null, keywords: [] };
}

describe('COLOR_LABEL_VALUES (#1657)', () => {
  it('is exactly the six-value union', () => {
    expect([...COLOR_LABEL_VALUES].sort()).toEqual(
      ['blue', 'green', 'orange', 'purple', 'red', 'yellow'].sort(),
    );
  });

  it('isColorLabelValue accepts every canonical value and rejects anything else', () => {
    for (const v of COLOR_LABEL_VALUES) {
      expect(isColorLabelValue(v)).toBe(true);
    }
    expect(isColorLabelValue('magenta')).toBe(false);
    expect(isColorLabelValue('')).toBe(false);
  });
});

describe('papp:ColorLabel round-trip through the real parser/serializer (#1657)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it.each(COLOR_LABEL_VALUES)('colorLabel=%s survives serialize → parse', (color) => {
    const culling: XmpCulling = { ...defaultCulling(), colorLabel: color };
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    expect(xml).toContain(`papp:ColorLabel="${color}"`);
    expect(parser.parseCulling(xml).colorLabel).toBe(color);
  });
});

describe('xmp:Label (Adobe interop word) parses every canonical color, including Purple (#1657)', () => {
  let parser: XmpParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
  });

  const LABEL_WORDS: Record<string, string> = {
    red: 'Red',
    orange: 'Orange',
    yellow: 'Yellow',
    green: 'Green',
    blue: 'Blue',
    purple: 'Purple',
  };

  it.each(COLOR_LABEL_VALUES)('xmp:Label="%s" (title case) parses to colorLabel %s', (color) => {
    const word = LABEL_WORDS[color];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Label="${word}">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
    expect(parser.parseCulling(xml).colorLabel).toBe(color);
  });
});
