// film-look.spec.ts — XMP `papp:FilmLook` / `papp:FilmStrength` round-trip
// (epic #2683, Task 12). Mirrors `auto-profile.spec.ts`'s shape for the
// sibling `papp:Profile` field. `filmLook` is a free-form catalog id string
// (not a fixed enum) so an id the parser doesn't recognise — an id from a
// newer catalog build than the one this client shipped with — must still
// round-trip byte-for-byte rather than being dropped or migrated.

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

describe('XMP papp:FilmLook / papp:FilmStrength round-trip (#2683)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  // ── Serialize → parse round trip ──────────────────────────────────────

  it('serializes a selected look as papp:FilmLook and round-trips through the parser', () => {
    const model = defaultAdjustmentModel();
    model.filmLook = 'slide_fuji_velvia_50';

    const xml = serializer.serialize(model);
    expect(xml).toContain('papp:FilmLook="slide_fuji_velvia_50"');

    const { model: parsed } = parser.parseAdjustmentModel(xml);
    expect(parsed.filmLook).toBe('slide_fuji_velvia_50');
  });

  it('serializes a non-default strength as papp:FilmStrength and round-trips', () => {
    const model = defaultAdjustmentModel();
    model.filmLook = 'slide_fuji_velvia_50';
    model.filmStrength = 65;

    const xml = serializer.serialize(model);
    expect(xml).toContain('papp:FilmStrength="65"');

    const { model: parsed } = parser.parseAdjustmentModel(xml);
    expect(parsed.filmStrength).toBe(65);
  });

  // ── Silent at defaults ────────────────────────────────────────────────

  it('omits both papp:FilmLook and papp:FilmStrength for a pristine default model', () => {
    const model = defaultAdjustmentModel();

    const xml = serializer.serialize(model);

    expect(xml).not.toContain('papp:FilmLook=');
    expect(xml).not.toContain('papp:FilmStrength=');
  });

  it('omits papp:FilmStrength when a look is selected but strength is untouched (100)', () => {
    const model = defaultAdjustmentModel();
    model.filmLook = 'black_white_kodak_tri_x_400';
    // filmStrength stays at its default (100).

    const xml = serializer.serialize(model);

    expect(xml).toContain('papp:FilmLook="black_white_kodak_tri_x_400"');
    expect(xml).not.toContain('papp:FilmStrength=');
  });

  it('parses an absent papp:FilmLook/papp:FilmStrength to the model defaults', () => {
    const xml = makeSidecar('');

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.filmLook).toBeUndefined();
    expect(model.filmStrength).toBeUndefined();
  });

  // ── Unknown id preserved (free-form, not an enum) ───────────────────────

  it('preserves an unrecognized film-catalog id verbatim (forward-compat)', () => {
    const xml = makeSidecar('papp:FilmLook="unreleased_future_catalog_id"');

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.filmLook).toBe('unreleased_future_catalog_id');
  });

  it('does not surface papp:FilmLook or papp:FilmStrength as unknownAttributes', () => {
    const xml = makeSidecar('papp:FilmLook="slide_fuji_velvia_50" papp:FilmStrength="65"');

    const { passthrough } = parser.parseAdjustmentModel(xml);

    const surfaced = passthrough.unknownAttributes.some(
      (a) => a.name === 'papp:FilmLook' || a.name === 'papp:FilmStrength',
    );
    expect(surfaced).toBe(false);
  });

  it('treats an empty papp:FilmLook attribute the same as absent', () => {
    const xml = makeSidecar('papp:FilmLook=""');

    const { model } = parser.parseAdjustmentModel(xml);

    expect(model.filmLook).toBeUndefined();
  });
});
