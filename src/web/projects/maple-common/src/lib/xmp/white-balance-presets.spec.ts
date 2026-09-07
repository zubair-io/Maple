import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  WHITE_BALANCE_PRESETS,
  WHITE_BALANCE_PRESET_VALUES,
} from '../generated/white-balance-presets.generated';
import { XmpParserService } from './xmp-parser.service';

function sidecar(attributes: string): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${attributes}/></rdf:RDF></x:xmpmeta>`;
}

describe('foreign named WB sidecars', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
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
