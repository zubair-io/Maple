// auto-profile.spec.ts — XMP papp:Profile round-trip + papp:Look legacy
// migration (Auto Profile Phase 1, #562). Mirrors raw-core's
// `xmp/mod.rs` Profile arm and the Swift tests under
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/`.

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

describe('XMP papp:Profile round-trip + papp:Look legacy migration (#562)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('serializes profile="Neutral" as papp:Profile="Neutral"', () => {
    const model = defaultAdjustmentModel();
    model.profile = 'Neutral';

    const xml = serializer.serialize(model);

    expect(xml).toContain('papp:Profile="Neutral"');
  });

  it('omits papp:Profile when profile is the default ("Auto")', () => {
    const model = defaultAdjustmentModel();

    const xml = serializer.serialize(model);

    expect(xml).not.toContain('papp:Profile=');
  });

  it('parses papp:Profile="Neutral" into model.profile === "Neutral"', () => {
    const xml = makeSidecar(`papp:Profile="Neutral"`);

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.profile).toBe('Neutral');
  });

  // Legacy `papp:Profile="AcrMatch"` (#1722, retired in #2312) migrates to
  // "Auto" — the profile that superseded it. The web parser's unknown-value
  // fallback already lands there; this pins it so the three platforms agree
  // (raw-core `xmp/fields.rs` and Apple `XMPSerialization+ParseAttrs.swift`
  // both carry an explicit arm).
  it('migrates retired papp:Profile="AcrMatch" into profile === "Auto"', () => {
    const xml = makeSidecar(`papp:Profile="AcrMatch"`);

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.profile).toBe('Auto');
  });

  it('migrates legacy papp:Look="Default" (no Profile) into profile === "Auto"', () => {
    const xml = makeSidecar(`papp:Look="Default"`);

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.profile).toBe('Auto');
  });

  it('migrates legacy papp:Look="Neutral" (no Profile) into profile === "Neutral"', () => {
    const xml = makeSidecar(`papp:Look="Neutral"`);

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.profile).toBe('Neutral');
  });

  it('papp:Profile wins over papp:Look when both present (Profile before Look)', () => {
    const xml = makeSidecar(`papp:Profile="Neutral" papp:Look="Default"`);

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.profile).toBe('Neutral');
  });

  it('papp:Profile wins over papp:Look when both present (Look before Profile)', () => {
    // Mirrors raw-core's `profile_seen` precedence (xmp/mod.rs) — the
    // canonical key wins regardless of attribute order in the source XML.
    const xml = makeSidecar(`papp:Look="Default" papp:Profile="Neutral"`);

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.profile).toBe('Neutral');
  });

  it('does not surface papp:Profile as an unknownAttribute', () => {
    const xml = makeSidecar(`papp:Profile="Neutral"`);

    const { passthrough } = parser.parseAdjustmentModel(xml);

    const surfaced = passthrough.unknownAttributes.some((a) => a.name === 'papp:Profile');
    expect(surfaced).toBe(false);
  });
});
