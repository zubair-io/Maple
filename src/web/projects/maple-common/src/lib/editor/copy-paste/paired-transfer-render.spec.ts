import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, render_bytes_sized } from '../../raw-pipeline/pkg/raw_wasm';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import { buildTransferPatch } from './adjustment-transfer';

const root = resolve(process.cwd(), '../../test-fixtures/batch-transfer');
const pair = JSON.parse(readFileSync(resolve(root, 'pair.json'), 'utf8')) as {
  fixtures: { name: string; width: number; height: number; temperature: number; tint: number }[];
  correction: { temperature: number; tint: number };
  crop: { top: number; left: number; bottom: number; right: number; angle: number };
};
const serializer = new XmpSerializerService();
const baselineModel = (): AdjustmentModel => ({ ...defaultAdjustmentModel(), profile: 'Neutral' });
function render(name: string, model: AdjustmentModel) {
  const image = render_bytes_sized(
    new Uint8Array(readFileSync(resolve(root, name + '.dng'))),
    'dng',
    serializer.serialize(model),
    false,
    1024,
  );
  try {
    return {
      width: image.width,
      height: image.height,
      temperature: image.as_shot_temperature,
      tint: image.as_shot_tint,
      rgb: image.take_rgb(),
    };
  } finally {
    image.free();
  }
}
function authored(index: number): AdjustmentModel {
  return {
    ...baselineModel(),
    temperature: pair.fixtures[index].temperature + pair.correction.temperature,
    tint: pair.fixtures[index].tint + pair.correction.tint,
    whiteBalancePreset: 'Custom',
    wbSource: 'Manual',
    wbScaleVersion: 5,
  };
}

describe('paired RAW transfer through the actual WASM renderer', () => {
  beforeAll(() =>
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    }),
  );
  it('renders relative WB as the independently authored correction to each own camera baseline', () => {
    const source = render('source', baselineModel());
    const target = render('target', baselineModel());
    expect(Math.round(source.temperature / 50) * 50).toBe(pair.fixtures[0].temperature);
    expect(Math.round(target.temperature / 50) * 50).toBe(pair.fixtures[1].temperature);
    expect(Math.abs(source.temperature - target.temperature)).toBeGreaterThan(1500);
    expect(Math.round(source.tint)).toBe(pair.fixtures[0].tint);
    expect(Math.round(target.tint)).toBe(pair.fixtures[1].tint);
    const request = {
      source: authored(0),
      groups: ['white_balance'] as const,
      sourceBaseline: pair.fixtures[0],
      relativeWhiteBalance: true,
    };
    const transferred = render('target', {
      ...baselineModel(),
      ...buildTransferPatch(request, pair.fixtures[1]),
    });
    const independent = render('target', authored(1));
    expect([...transferred.rgb]).toEqual([...independent.rgb]);
    const wrongAbsolute = render('target', {
      ...baselineModel(),
      ...buildTransferPatch({ ...request, relativeWhiteBalance: false }),
    });
    const difference =
      transferred.rgb.reduce((sum, value, i) => sum + Math.abs(value - wrongAbsolute.rgb[i]), 0) /
      transferred.rgb.length;
    expect(
      difference,
      'an absolute number copy must be observably different from relative transfer',
    ).toBeGreaterThan(1);
  });
  it('applies normalized geometry to a portrait target, with pixels matching its own uncropped center', () => {
    const source = { ...authored(0), crop: pair.crop };
    const patch = buildTransferPatch(
      {
        source,
        groups: ['white_balance', 'geometry'],
        sourceBaseline: pair.fixtures[0],
        relativeWhiteBalance: true,
      },
      pair.fixtures[1],
    );
    const transferred = render('target', { ...baselineModel(), ...patch });
    const full = render('target', authored(1));
    expect([full.width, full.height]).toEqual([80, 120]);
    expect([transferred.width, transferred.height]).toEqual([40, 60]);
    const center = new Uint8Array(40 * 60 * 3);
    for (let y = 0; y < 60; y++)
      center.set(full.rgb.subarray(((y + 30) * 80 + 20) * 3, ((y + 30) * 80 + 60) * 3), y * 40 * 3);
    expect([...transferred.rgb]).toEqual([...center]);
    expect([render('source', source).width, render('source', source).height]).toEqual([48, 32]);
  });
});
