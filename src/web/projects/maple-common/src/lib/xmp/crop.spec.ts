// crop.spec.ts — round-trip coverage for the crop/straighten parse branch in
// `XmpParserService.parseAdjustmentModel` (ticket #277) ahead of the #1840
// extraction into `xmp-crop.ts`. The canonical-fixture test in
// `xmp-canonical.spec.ts` exercises the full-rect + angle case together;
// this file covers the branches that fixture doesn't reach on its own:
// no crop attributes at all, a pure-straighten angle with no rect trim
// (`crs:HasCrop` absent or "False"), a lowercase `hasCrop` spelling, and a
// partial rect where some edges are left at their identity default.

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

describe('XMP crop / straighten parsing (#277)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('leaves crop undefined when no crop attributes are present', () => {
    const { model } = parser.parseAdjustmentModel(makeSidecar('crs:Exposure2012="0.5"'));
    expect(model.crop).toBeUndefined();
  });

  it('ignores the rect fields when crs:HasCrop is absent, even if present in the XML', () => {
    // crs:HasCrop is not sent at all — CropTop et al. must not be applied.
    const { model } = parser.parseAdjustmentModel(makeSidecar('crs:CropTop="0.2"'));
    expect(model.crop).toBeUndefined();
  });

  it('ignores the rect fields when crs:HasCrop="False"', () => {
    const { model } = parser.parseAdjustmentModel(
      makeSidecar('crs:HasCrop="False" crs:CropTop="0.2" crs:CropLeft="0.1"'),
    );
    expect(model.crop).toBeUndefined();
  });

  it('applies a pure straighten (CropAngle with no HasCrop) at the identity rect', () => {
    const { model } = parser.parseAdjustmentModel(makeSidecar('crs:CropAngle="3.25"'));
    expect(model.crop).toEqual({ top: 0, left: 0, bottom: 1, right: 1, angle: 3.25 });
  });

  it('accepts the lowercase "true" spelling of crs:HasCrop', () => {
    const { model } = parser.parseAdjustmentModel(
      makeSidecar(
        'crs:HasCrop="true" crs:CropTop="0.1" crs:CropLeft="0.05" crs:CropBottom="0.9" crs:CropRight="0.95"',
      ),
    );
    expect(model.crop).toEqual({ top: 0.1, left: 0.05, bottom: 0.9, right: 0.95, angle: 0 });
  });

  it('fills a partial rect with the identity default for the missing edges', () => {
    const { model } = parser.parseAdjustmentModel(
      makeSidecar('crs:HasCrop="True" crs:CropTop="0.2"'),
    );
    expect(model.crop).toEqual({ top: 0.2, left: 0, bottom: 1, right: 1, angle: 0 });
  });

  it('round-trips a rect + angle crop through serialize -> parse', () => {
    const model = {
      ...defaultAdjustmentModel(),
      crop: { top: 0.1, left: 0.2, bottom: 0.8, right: 0.9, angle: -4 },
    };
    const xml = serializer.serialize(model);
    const { model: parsed } = parser.parseAdjustmentModel(xml);
    expect(parsed.crop).toEqual(model.crop);
  });

  it('round-trips a pure-straighten crop (identity rect, non-zero angle)', () => {
    const model = {
      ...defaultAdjustmentModel(),
      crop: { top: 0, left: 0, bottom: 1, right: 1, angle: 1.5 },
    };
    const xml = serializer.serialize(model);
    expect(xml).toContain('crs:CropAngle="1.500000"');
    expect(xml).not.toContain('crs:HasCrop');
    const { model: parsed } = parser.parseAdjustmentModel(xml);
    expect(parsed.crop).toEqual(model.crop);
  });

  it('omits every crop attribute for an identity crop', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('crs:HasCrop');
    expect(xml).not.toContain('crs:CropTop');
    expect(xml).not.toContain('crs:CropAngle');
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.crop).toBeUndefined();
  });
});
