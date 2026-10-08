// xmp-rating-label-preservation.spec.ts — foreign `xmp:Rating` / `xmp:Label`
// spellings survive saves that never touch them (#4403).
//
// A Lightroom reject (`xmp:Rating="-1"`) parsed to 0 and a Lightroom colour
// word (`xmp:Label="Blue"`) converted to `papp:ColorLabel`, and because both
// names sat in the owned set neither original survived the save. The contract
// from #4403 (mirroring the Linux shell's `keep_rating` rule, and the Apple
// half in `XMPRatingLabelPreservationTests.swift`) is: a value the user did
// not change is kept exactly as authored, and rewritten only when the user
// edits that field. Reads are unchanged — `xmp:Label` still parses as the
// Adobe colour word, so a kept `Red` still reads as red and now also emits
// the canonical `papp:ColorLabel` next to the preserved raw.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling } from './xmp.types';

/** A Lightroom-authored sidecar, trimmed to the attributes under test. */
function authorSidecar(attrs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:papp="http://ns.justmaple.app/1.0/"
    ${attrs}>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('foreign rating/label spellings survive untouched saves (#4403)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  /** Parse → apply `edit` → serialize, threading the passthrough bucket
   * the way the real save path does. */
  const resave = (
    xml: string,
    edit?: (model: AdjustmentModel, culling: XmpCulling) => void,
  ): string => {
    const { model: parsed, passthrough } = parser.parseAdjustmentModel(xml);
    const model = { ...defaultAdjustmentModel(), ...parsed };
    const culling = parser.parseCulling(xml);
    edit?.(model, culling);
    return serializer.serialize(model, passthrough, culling);
  };

  it('a Lightroom reject survives an unrelated edit', () => {
    const xml = resave(authorSidecar('xmp:Rating="-1"'), (model) => {
      model.exposure = 0.5;
    });
    expect(xml).toContain('xmp:Rating="-1"');
    expect(occurrences(xml, 'xmp:Rating')).toBe(1);
  });

  it.each(['3.0', '03'])('an unchanged %s keeps its bytes instead of normalizing', (raw) => {
    const xml = resave(authorSidecar(`xmp:Rating="${raw}"`));
    expect(xml).toContain(`xmp:Rating="${raw}"`);
    expect(occurrences(xml, 'xmp:Rating')).toBe(1);
  });

  it('an edited rating rewrites canonically and drops the raw', () => {
    const xml = resave(authorSidecar('xmp:Rating="-1"'), (_, culling) => {
      culling.rating = 4;
    });
    expect(xml).toContain('xmp:Rating="4"');
    expect(xml).not.toContain('xmp:Rating="-1"');
    expect(occurrences(xml, 'xmp:Rating')).toBe(1);
  });

  it('a cleared rating removes the attribute entirely', () => {
    const xml = resave(authorSidecar('xmp:Rating="3"'), (_, culling) => {
      culling.rating = 0;
    });
    expect(xml).not.toContain('xmp:Rating');
  });

  it('a canonical rating still emits exactly once', () => {
    const xml = resave(authorSidecar('xmp:Rating="3"'));
    expect(xml).toContain('xmp:Rating="3"');
    expect(occurrences(xml, 'xmp:Rating')).toBe(1);
  });

  it('an unprefixed Rating raw survives unedited', () => {
    const xml = resave(authorSidecar('Rating="-1"'));
    expect(xml).toContain('Rating="-1"');
    expect(occurrences(xml, 'Rating=')).toBe(1);
  });

  it('an Adobe colour word survives unedited next to the canonical label', () => {
    const xml = resave(authorSidecar('xmp:Label="Red"'));
    expect(xml).toContain('xmp:Label="Red"');
    expect(xml).toContain('papp:ColorLabel="red"');
  });

  it('an edited colour label rewrites canonically and drops the raw', () => {
    const xml = resave(authorSidecar('xmp:Label="Red"'), (_, culling) => {
      culling.colorLabel = 'blue';
    });
    expect(xml).not.toContain('xmp:Label');
    expect(xml).toContain('papp:ColorLabel="blue"');
  });

  it('a cleared colour label removes both spellings', () => {
    const xml = resave(authorSidecar('xmp:Label="Red"'), (_, culling) => {
      culling.colorLabel = null;
    });
    expect(xml).not.toContain('xmp:Label');
    expect(xml).not.toContain('papp:ColorLabel');
  });

  it('a non-colour label word survives unedited', () => {
    const xml = resave(authorSidecar('xmp:Label="Rejected"'));
    expect(xml).toContain('xmp:Label="Rejected"');
    expect(xml).not.toContain('papp:ColorLabel');
  });

  it('an unprefixed Label raw survives unedited', () => {
    const xml = resave(authorSidecar('Label="Blue"'));
    expect(xml).toContain('Label="Blue"');
    expect(xml).toContain('papp:ColorLabel="blue"');
  });

  it('a fixed point: re-saving the output changes nothing', () => {
    const once = resave(authorSidecar('xmp:Rating="-1" xmp:Label="Blue"'), (model) => {
      model.exposure = 0.5;
    });
    const twice = resave(once);
    expect(twice).toBe(once);
  });
});
