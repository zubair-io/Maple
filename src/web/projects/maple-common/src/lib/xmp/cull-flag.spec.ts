// cull-flag.spec.ts — `papp:Flag` is the cross-platform cull-flag wire key (#2221).
//
// The Apple serializer used to write the flag as `xmp:Label="Red"` /
// `"Rejected"`. Nothing on this side reads that as a flag — `xmp:Label` is
// the Adobe *colour* word here — so an Apple pick arrived as a red colour
// label and an Apple reject arrived as nothing at all. Apple now emits the
// same `papp:Flag` attribute this serializer does, with the same lowercase
// vocabulary.
//
// These cases pin the shared literals from the web side; the Apple side
// pins the identical strings in `XMPCullFlagTests.swift`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling, XmpFlag } from './xmp.types';

function defaultCulling(): XmpCulling {
  return { rating: 0, flag: 'unflagged', colorLabel: null, keywords: [] };
}

/** An Apple-authored sidecar, trimmed to the attributes under test. */
function appleSidecar(attrs: string): string {
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

describe('papp:Flag round-trips through the real parser/serializer', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it.each<XmpFlag>(['pick', 'reject'])('flag=%s survives serialize → parse', (flag) => {
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, {
      ...defaultCulling(),
      flag,
    });
    expect(xml).toContain(`papp:Flag="${flag}"`);
    expect(parser.parseCulling(xml).flag).toBe(flag);
  });

  it('unflagged omits the attribute entirely', () => {
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, defaultCulling());
    expect(xml).not.toContain('papp:Flag=');
    expect(parser.parseCulling(xml).flag).toBe('unflagged');
  });
});

describe('an Apple-authored cull flag reaches the web path (#2221)', () => {
  let parser: XmpParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
  });

  it.each<XmpFlag>(['pick', 'reject'])('papp:Flag="%s" parses to the same flag', (flag) => {
    const culling = parser.parseCulling(appleSidecar(`papp:Flag="${flag}"`));
    expect(culling.flag).toBe(flag);
    // The flag must not leak into the colour label — those are separate
    // fields with separate attributes on every side.
    expect(culling.colorLabel).toBeNull();
  });

  it('a flag and a colour label coexist without either shadowing the other', () => {
    const culling = parser.parseCulling(appleSidecar('papp:Flag="reject" papp:ColorLabel="blue"'));
    expect(culling.flag).toBe('reject');
    expect(culling.colorLabel).toBe('blue');
  });
});
