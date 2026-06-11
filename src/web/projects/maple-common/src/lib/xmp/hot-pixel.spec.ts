// hot-pixel.spec.ts — XMP round-trip for hot/dead-pixel suppression
// (#1106, tone/zoom design § 10.6).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
// and the Rust tests in `raw-core/src/xmp/tests_modes.rs` —
// `papp:HotPixelSuppression` parses case-insensitively, serializes only
// when non-default ('Off'), and unknown values fall back to the default
// instead of blocking sidecar load.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';

function makeSidecar(attrs: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:papp="http://ns.justmaple.app/photo/1.0/"
    crs:Version="11.0"
    ${attrs}>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

describe('XMP HotPixelSuppression field (#1106)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses `papp:HotPixelSuppression` case-insensitively', () => {
    const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:HotPixelSuppression="On"`));
    expect(model.hotPixelSuppression).toBe('On');
    const { model: m2 } = parser.parseAdjustmentModel(
      makeSidecar(`papp:HotPixelSuppression="off"`),
    );
    expect(m2.hotPixelSuppression).toBe('Off');
  });

  it('drops unknown values so the field takes its default', () => {
    const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:HotPixelSuppression="Maybe"`));
    expect(model.hotPixelSuppression).toBeUndefined();
    const merged = { ...defaultAdjustmentModel(), ...model };
    expect(merged.hotPixelSuppression).toBe('Off');
  });

  it('round-trips a non-default value through serialize → parse', () => {
    const m = defaultAdjustmentModel();
    m.hotPixelSuppression = 'On';
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:HotPixelSuppression="On"');
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.hotPixelSuppression).toBe('On');
  });

  it('omits `papp:HotPixelSuppression` at the default (Off) so pre-#1106 sidecars stay byte-identical', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('papp:HotPixelSuppression');
  });
});
