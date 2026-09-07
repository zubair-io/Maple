import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  WHITE_BALANCE_PRESETS,
  WHITE_BALANCE_PRESET_VALUES,
} from '../generated/white-balance-presets.generated';
import { XmpParserService } from './xmp-parser.service';

function sidecar(attributes: string, children = ''): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${attributes}>${children}</rdf:Description></rdf:RDF></x:xmpmeta>`;
}

describe('foreign named WB sidecars', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('infers Manual for an authored foreign Custom pair, including a missing preset name', () => {
    const parser = TestBed.inject(XmpParserService);
    for (const preset of ['', 'crs:WhiteBalance="Custom"']) {
      const model = parser.parseAdjustmentModel(
        sidecar(`${preset} crs:Temperature="5100" crs:Tint="-7"`),
      ).model;
      expect(model).toMatchObject({
        temperature: 5100,
        tint: -7,
        whiteBalancePreset: 'Custom',
        wbSource: 'Manual',
      });
    }
  });

  it('preserves Maple legacy defaults and explicit provenance', () => {
    const parser = TestBed.inject(XmpParserService);
    const attrs = 'crs:WhiteBalance="Custom" crs:Temperature="5100" crs:Tint="-7"';
    const namespace = 'xmlns:papp="http://ns.justmaple.app/photo/1.0/"';
    expect(
      parser.parseAdjustmentModel(sidecar(`${attrs} ${namespace}`)).model.wbSource,
    ).toBeUndefined();
    expect(
      parser.parseAdjustmentModel(sidecar(attrs, `<papp:Private ${namespace}>note</papp:Private>`))
        .model.wbSource,
    ).toBeUndefined();
    for (const source of ['AsShot', 'Auto', 'Sampled', 'Manual', 'Preset']) {
      expect(
        parser.parseAdjustmentModel(sidecar(`${attrs} ${namespace} papp:WbSource="${source}"`))
          .model.wbSource,
      ).toBe(source);
    }
  });

  it('does not invent Manual for As Shot or an unauthored Custom choice', () => {
    const parser = TestBed.inject(XmpParserService);
    for (const attrs of [
      'crs:WhiteBalance="As Shot" crs:Temperature="5100" crs:Tint="-7"',
      'crs:WhiteBalance="Custom"',
      '',
    ]) {
      expect(parser.parseAdjustmentModel(sidecar(attrs)).model.wbSource).toBeUndefined();
    }
  });

  it('preserves provenance for late Maple namespace aliases and default bindings', () => {
    const parser = TestBed.inject(XmpParserService);
    const attrs = 'crs:WhiteBalance="Custom" crs:Temperature="5100" crs:Tint="-7"';
    for (const uri of ['http://ns.justmaple.app/photo/1.0/', 'http://ns.justmaple.app/1.0/']) {
      for (const marker of [
        `<m:Private xmlns:m="${uri}">note</m:Private>`,
        `<Private xmlns="${uri}">note</Private>`,
      ]) {
        const model = parser.parseAdjustmentModel(sidecar(attrs, marker)).model;
        expect(model.wbSource).toBeUndefined();
        expect(model).toMatchObject({ temperature: 5100, tint: -7 });
      }
    }
    expect(
      parser.parseAdjustmentModel(
        sidecar(attrs, '<m:Private xmlns:m="https://example.org/metadata/">note</m:Private>'),
      ).model.wbSource,
    ).toBe('Manual');
  });

  for (const preset of WHITE_BALANCE_PRESETS.filter((name) => WHITE_BALANCE_PRESET_VALUES[name])) {
    it(`${preset} resolves on read and explicit numbers take precedence in either order`, () => {
      const parser = TestBed.inject(XmpParserService);
      expect(
        parser.parseAdjustmentModel(sidecar(`crs:WhiteBalance="${preset}"`)).model,
      ).toMatchObject({
        ...WHITE_BALANCE_PRESET_VALUES[preset],
        whiteBalancePreset: preset,
        wbSource: 'Preset',
        wbScaleVersion: 5,
      });
      for (const attrs of [
        `crs:WhiteBalance="${preset}" crs:Temperature="5000" crs:Tint="-8"`,
        `crs:Temperature="5000" crs:Tint="-8" crs:WhiteBalance="${preset}"`,
      ]) {
        expect(parser.parseAdjustmentModel(sidecar(attrs)).model).toMatchObject({
          temperature: 5000,
          tint: -8,
          whiteBalancePreset: preset,
        });
      }
    });
  }
});
