// demosaic.spec.ts — XMP round-trip for the Bayer demosaic kernel override
// (#3413).
//
// Mirrors the Rust tests in `raw-core/src/xmp/tests_modes.rs` and the Swift
// ones in `MapleCoreTests` — `papp:Demosaic` parses case-insensitively,
// serializes only when the user has pinned a kernel, and an unknown value
// falls back to the 'Auto' default instead of blocking sidecar load.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { DemosaicChoice } from '../generated/adjustment-model.generated';

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

const NON_DEFAULT: readonly DemosaicChoice[] = ['Amaze', 'Rcd', 'DualAmaze', 'DualRcd', 'Lmmse'];

describe('XMP Demosaic field (#3413)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses every variant, case-insensitively', () => {
    for (const choice of [...NON_DEFAULT, 'Auto' as DemosaicChoice]) {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:Demosaic="${choice}"`));
      expect(model.demosaic).toBe(choice);
      const { model: lower } = parser.parseAdjustmentModel(
        makeSidecar(`papp:Demosaic="${choice.toLowerCase()}"`),
      );
      expect(lower.demosaic).toBe(choice);
    }
  });

  it('drops an unknown kernel name so the field takes its Auto default', () => {
    const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:Demosaic="Bilinear"`));
    expect(model.demosaic).toBeUndefined();
    expect({ ...defaultAdjustmentModel(), ...model }.demosaic).toBe('Auto');
  });

  it('round-trips every pinned kernel through serialize → parse', () => {
    for (const choice of NON_DEFAULT) {
      const m = defaultAdjustmentModel();
      m.demosaic = choice;
      const xml = serializer.serialize(m);
      expect(xml).toContain(`papp:Demosaic="${choice}"`);
      expect(parser.parseAdjustmentModel(xml).model.demosaic).toBe(choice);
    }
  });

  it('omits `papp:Demosaic` at the Auto default, so an untouched sidecar keeps following the policy', () => {
    expect(serializer.serialize(defaultAdjustmentModel())).not.toContain('papp:Demosaic');
  });
});
