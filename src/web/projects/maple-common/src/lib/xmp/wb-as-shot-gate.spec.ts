// wb-as-shot-gate.spec.ts — the As-Shot WB display-seed contract (#1892).
//
// An As-Shot model's temperature/tint are the camera's display seed
// (`seedAsShotWhiteBalance`), not authored values: the serializer omits them
// so the render paths take raw-core's exact As-Shot sentinel, and any real
// WB edit flips the preset to 'Custom' (store) so authored values survive.
// Mirrors raw-core's `temperature_seen`/`tint_seen` semantics.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { LibraryStore } from '../state/library-store.service';
import type { AssetId } from '../models/asset';

describe('As-Shot WB gate (#1892)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;
  let store: LibraryStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
    store = TestBed.inject(LibraryStore);
  });

  it('omits temperature/tint for an As-Shot model (display seed, not an edit)', () => {
    const m = { ...defaultAdjustmentModel(), temperature: 5520, tint: -144 };
    const xml = serializer.serialize(m);
    expect(xml).not.toContain('crs:Temperature');
    expect(xml).not.toContain('crs:Tint');
    expect(xml).not.toContain('papp:WbScaleVersion');
  });

  it('emits temperature/tint for a Custom model', () => {
    const m = {
      ...defaultAdjustmentModel(),
      temperature: 5000,
      tint: 12,
      whiteBalancePreset: 'Custom' as const,
    };
    const xml = serializer.serialize(m);
    expect(xml).toContain('crs:Temperature="5000"');
    expect(xml).toContain('crs:Tint="12"');
    expect(xml).toContain('crs:WhiteBalance="Custom"');
  });

  it('emits temperature/tint for a named preset', () => {
    const m = {
      ...defaultAdjustmentModel(),
      temperature: 2850,
      tint: 0,
      whiteBalancePreset: 'Tungsten' as const,
    };
    const xml = serializer.serialize(m);
    expect(xml).toContain('crs:Temperature="2850"');
    expect(xml).toContain('crs:WhiteBalance="Tungsten"');
  });

  it('parses authored temperature with no crs:WhiteBalance as Custom (legacy sidecars)', () => {
    // Sidecars written before the gate never stamped a preset alongside
    // slider edits — inferring 'Custom' keeps a load→save round-trip from
    // dropping the authored pair.
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Temperature="7625" crs:Tint="-3">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.whiteBalancePreset).toBe('Custom');

    const merged = { ...defaultAdjustmentModel(), ...model };
    const reserialized = serializer.serialize(merged);
    expect(reserialized).toContain('crs:Temperature="7625"');
    expect(reserialized).toContain('crs:Tint="-3"');
  });

  it('leaves the preset alone when the sidecar has no WB fields at all', () => {
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Exposure2012="0.5">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.whiteBalancePreset).toBeUndefined();
  });

  it('flips the preset to Custom on a WB slider patch (store)', () => {
    const id = 'asset-1' as AssetId;
    store.setAdjustment(id, { temperature: 5000 });
    expect(store.adjustmentFor(id)().whiteBalancePreset).toBe('Custom');
  });

  it('does not flip the preset when the patch carries one explicitly (RESET, pills)', () => {
    const id = 'asset-2' as AssetId;
    store.setAdjustment(id, { temperature: 5520, tint: -144, whiteBalancePreset: 'As Shot' });
    expect(store.adjustmentFor(id)().whiteBalancePreset).toBe('As Shot');
  });

  it('does not flip the preset on a non-WB patch', () => {
    const id = 'asset-3' as AssetId;
    store.setAdjustment(id, { exposure: 1.0 });
    expect(store.adjustmentFor(id)().whiteBalancePreset).toBe('As Shot');
  });

  it('seedAsShotWhiteBalance keeps the As-Shot preset (seed is not an edit)', () => {
    const id = 'asset-4' as AssetId;
    store.seedAsShotWhiteBalance(id, 5520, -144.4);
    const m = store.adjustmentFor(id)();
    expect(m.whiteBalancePreset).toBe('As Shot');
    expect(m.temperature).toBe(5500); // 50 K snap
    expect(m.tint).toBe(-144); // integer round
    // The seeded pair must not serialize.
    expect(serializer.serialize(m)).not.toContain('crs:Temperature');
  });
});
