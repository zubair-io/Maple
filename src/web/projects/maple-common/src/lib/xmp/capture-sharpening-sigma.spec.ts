// capture-sharpening-sigma.spec.ts — XMP sigma/radius migration round-trip
// (KTLO #464). Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AdjustmentModelTests.swift`
// — both platforms write the canonical `papp:CaptureSharpeningSigma` and
// accept the legacy `papp:CaptureSharpeningRadius` on read.

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

describe('XMP capture-sharpening sigma migration (#464)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('serializes captureSharpeningSigma to papp:CaptureSharpeningSigma (not the legacy Radius key)', () => {
    const model = defaultAdjustmentModel();
    model.captureSharpeningAmount = 55;
    model.captureSharpeningSigma = 2.0;

    const xml = serializer.serialize(model);

    expect(xml).toContain('papp:CaptureSharpeningSigma="2"');
    expect(xml).not.toContain('papp:CaptureSharpeningRadius');
  });

  it('round-trips captureSharpeningSigma=2.0 via the canonical key', () => {
    const model = defaultAdjustmentModel();
    model.captureSharpeningAmount = 55;
    model.captureSharpeningSigma = 2.0;

    const xml = serializer.serialize(model);
    const { model: parsed } = parser.parseAdjustmentModel(xml);

    expect(parsed.captureSharpeningAmount).toBe(55);
    expect(parsed.captureSharpeningSigma).toBe(2.0);
  });

  it('parses a legacy papp:CaptureSharpeningRadius="1.5" sidecar into captureSharpeningSigma=1.5', () => {
    const xml = makeSidecar(`papp:CaptureSharpeningAmount="65" papp:CaptureSharpeningRadius="1.5"`);

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.captureSharpeningAmount).toBe(65);
    expect(model.captureSharpeningSigma).toBe(1.5);
  });

  it('canonical Sigma wins when both keys are present (Radius before Sigma)', () => {
    const xml = makeSidecar(`papp:CaptureSharpeningRadius="1.5" papp:CaptureSharpeningSigma="2.0"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.captureSharpeningSigma).toBe(2.0);
  });

  it('canonical Sigma wins when both keys are present (Sigma before Radius)', () => {
    // Mirrors raw-core's `sigma_seen` precedence (PR #463) — the canonical
    // key wins regardless of attribute order in the source XML.
    const xml = makeSidecar(`papp:CaptureSharpeningSigma="2.0" papp:CaptureSharpeningRadius="1.5"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.captureSharpeningSigma).toBe(2.0);
  });

  it('does not surface the legacy radius key as an unknownAttribute', () => {
    const xml = makeSidecar(`papp:CaptureSharpeningRadius="1.5"`);
    const { passthrough } = parser.parseAdjustmentModel(xml);
    const legacyKeptAsUnknown = passthrough.unknownAttributes.some(
      (a) => a.name === 'papp:CaptureSharpeningRadius',
    );
    expect(legacyKeptAsUnknown).toBe(false);
  });
});
