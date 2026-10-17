// wb-dng-temperature.spec.ts — pins the TS Robertson-isotherm port
// (`wb-dng-temperature.ts`) and the legacy-to-V5 pair conversion
// (`authoredPairToV5` in `xmp-wb-scale.ts`) against golden vectors
// generated from the Rust reference implementation (single source of
// truth — `raw-core`'s `color::dng_temperature::golden_vectors_for_cross_
// language_ports` test). Ticket #1894 design comment item 8: cross-
// language ports must reproduce these numbers bit-for-bit-close, not
// merely "look right" in each language's own test suite.
//
// Tolerances (per the design comment):
//  - `tempTintToXy` xy values: within 1e-6.
//  - `xyToTempTint` temp/tint: within 0.05 K / 0.005 tint.
//  - `authoredPairToV5` out_temp/out_tint: within 0.05 K / 0.005 tint.
//
// The vectors are copied inline (not read from disk) — Vitest specs can't
// reach the scratchpad file the Rust test wrote its golden JSON to at
// runtime.

import { describe, it, expect } from 'vitest';
import { tempTintToXy, xyToTempTint } from './wb-dng-temperature';
import { authoredPairToV5 } from './xmp-wb-scale';

const TEMP_TINT_TO_XY: ReadonlyArray<{ temp: number; tint: number; x: number; y: number }> = [
  { temp: 2200.0, tint: -90.0, x: 0.44881463050842285, y: 0.3330320119857788 },
  { temp: 2200.0, tint: 0.0, x: 0.5055774450302124, y: 0.4151369333267212 },
  { temp: 2200.0, tint: 40.0, x: 0.5363673567771912, y: 0.4596731960773468 },
  { temp: 2856.0, tint: -90.0, x: 0.4059551954269409, y: 0.32726213335990906 },
  { temp: 2856.0, tint: 0.0, x: 0.4475476145744324, y: 0.407437264919281 },
  { temp: 2856.0, tint: 40.0, x: 0.4701326787471771, y: 0.4509730935096741 },
  { temp: 4000.0, tint: -90.0, x: 0.3619736433029175, y: 0.30864250659942627 },
  { temp: 4000.0, tint: 0.0, x: 0.3804461658000946, y: 0.3767562508583069 },
  { temp: 4000.0, tint: 40.0, x: 0.3902992010116577, y: 0.41308727860450745 },
  { temp: 5000.0, tint: -90.0, x: 0.33996671438217163, y: 0.29419222474098206 },
  { temp: 5000.0, tint: 0.0, x: 0.3451041281223297, y: 0.3516225218772888 },
  { temp: 5000.0, tint: 40.0, x: 0.3477909564971924, y: 0.38165807723999023 },
  { temp: 6500.0, tint: -90.0, x: 0.3198969066143036, y: 0.2777283787727356 },
  { temp: 6500.0, tint: 0.0, x: 0.313527911901474, y: 0.3235340714454651 },
  { temp: 6500.0, tint: 40.0, x: 0.31027477979660034, y: 0.3469306230545044 },
  { temp: 8000.0, tint: -90.0, x: 0.3076633810997009, y: 0.26627570390701294 },
  { temp: 8000.0, tint: 0.0, x: 0.2951829135417938, y: 0.30476856231689453 },
  { temp: 8000.0, tint: 40.0, x: 0.2889087498188019, y: 0.3241196572780609 },
  { temp: 12000.0, tint: -90.0, x: 0.2909998297691345, y: 0.24857226014137268 },
  { temp: 12000.0, tint: 0.0, x: 0.27180832624435425, y: 0.2775730788707733 },
  { temp: 12000.0, tint: 40.0, x: 0.262368381023407, y: 0.29183804988861084 },
  { temp: 20000.0, tint: -90.0, x: 0.27914875745773315, y: 0.23461896181106567 },
  { temp: 20000.0, tint: 0.0, x: 0.25645267963409424, y: 0.2576335072517395 },
  { temp: 20000.0, tint: 40.0, x: 0.24544940888881683, y: 0.26879119873046875 },
];

const XY_TO_TEMP_TINT: ReadonlyArray<{ x: number; y: number; temp: number; tint: number }> = [
  {
    temp: 2199.999755859375,
    tint: -90.00000762939453,
    x: 0.44881463050842285,
    y: 0.3330320119857788,
  },
  {
    temp: 2199.999755859375,
    tint: -9.548301932227332e-6,
    x: 0.5055774450302124,
    y: 0.4151369333267212,
  },
  {
    temp: 2200.0,
    tint: 40.00000762939453,
    x: 0.5363673567771912,
    y: 0.4596731960773468,
  },
  {
    temp: 2855.999755859375,
    tint: -89.99999237060547,
    x: 0.4059551954269409,
    y: 0.32726213335990906,
  },
  {
    temp: 2856.0,
    tint: -1.5299507140298374e-5,
    x: 0.4475476145744324,
    y: 0.407437264919281,
  },
  {
    temp: 2856.0,
    tint: 39.9999885559082,
    x: 0.4701326787471771,
    y: 0.4509730935096741,
  },
  {
    temp: 3999.999755859375,
    tint: -89.99999237060547,
    x: 0.3619736433029175,
    y: 0.30864250659942627,
  },
  {
    temp: 4000.000244140625,
    tint: 2.2742271539755166e-5,
    x: 0.3804461658000946,
    y: 0.3767562508583069,
  },
  {
    temp: 4000.0,
    tint: 39.99999237060547,
    x: 0.3902992010116577,
    y: 0.41308727860450745,
  },
  {
    temp: 5000.0009765625,
    tint: -89.99999237060547,
    x: 0.33996671438217163,
    y: 0.29419222474098206,
  },
  {
    temp: 5000.00048828125,
    tint: 1.7960110199055634e-5,
    x: 0.3451041281223297,
    y: 0.3516225218772888,
  },
  {
    temp: 5000.00048828125,
    tint: 40.0000114440918,
    x: 0.3477909564971924,
    y: 0.38165807723999023,
  },
  {
    temp: 6500.01318359375,
    tint: -90.00000762939453,
    x: 0.3198969066143036,
    y: 0.2777283787727356,
  },
  {
    temp: 6500.009765625,
    tint: -7.710699719609693e-6,
    x: 0.313527911901474,
    y: 0.3235340714454651,
  },
  {
    temp: 6500.0078125,
    tint: 40.00001907348633,
    x: 0.31027477979660034,
    y: 0.3469306230545044,
  },
  {
    temp: 7999.9990234375,
    tint: -89.99999237060547,
    x: 0.3076633810997009,
    y: 0.26627570390701294,
  },
  {
    temp: 8000.0,
    tint: 2.4420609406661242e-5,
    x: 0.2951829135417938,
    y: 0.30476856231689453,
  },
  {
    temp: 7999.99951171875,
    tint: 40.00001907348633,
    x: 0.2889087498188019,
    y: 0.3241196572780609,
  },
  {
    temp: 11999.994140625,
    tint: -89.99998474121094,
    x: 0.2909998297691345,
    y: 0.24857226014137268,
  },
  {
    temp: 11999.99609375,
    tint: -2.6500194962864043e-6,
    x: 0.27180832624435425,
    y: 0.2775730788707733,
  },
  {
    temp: 11999.99609375,
    tint: 40.0,
    x: 0.262368381023407,
    y: 0.29183804988861084,
  },
  {
    temp: 20000.0,
    tint: -89.99998474121094,
    x: 0.27914875745773315,
    y: 0.23461896181106567,
  },
  {
    temp: 20000.009765625,
    tint: 1.3056283933110535e-5,
    x: 0.25645267963409424,
    y: 0.2576335072517395,
  },
  {
    temp: 20000.00390625,
    tint: 39.999996185302734,
    x: 0.24544940888881683,
    y: 0.26879119873046875,
  },
];

const AUTHORED_PAIR_TO_V5: ReadonlyArray<{
  version: 'V1' | 'V2' | 'V3' | 'V4';
  temp: number;
  tint: number;
  out_temp: number;
  out_tint: number;
}> = [
  {
    out_temp: 6454.1572265625,
    out_tint: 9.982888221740723,
    temp: 6500.0,
    tint: 0.0,
    version: 'V1',
  },
  {
    out_temp: 5024.43603515625,
    out_tint: 12.819326400756836,
    temp: 5000.0,
    tint: 10.0,
    version: 'V1',
  },
  {
    out_temp: 3240.382568359375,
    out_tint: -8.740213394165039,
    temp: 3200.0,
    tint: -44.0,
    version: 'V1',
  },
  {
    out_temp: 5697.5654296875,
    out_tint: 24.960861206054688,
    temp: 5700.0,
    tint: 50.0,
    version: 'V1',
  },
  {
    out_temp: 5526.06787109375,
    out_tint: -33.04674530029297,
    temp: 5520.0,
    tint: -144.0,
    version: 'V1',
  },
  {
    out_temp: 5524.8505859375,
    out_tint: -5.745927333831787,
    temp: 5520.0,
    tint: -53.0,
    version: 'V1',
  },
  {
    out_temp: 6454.1572265625,
    out_tint: 9.982888221740723,
    temp: 6500.0,
    tint: 0.0,
    version: 'V2',
  },
  {
    out_temp: 5026.10302734375,
    out_tint: 6.82279634475708,
    temp: 5000.0,
    tint: 10.0,
    version: 'V2',
  },
  {
    out_temp: 3221.401611328125,
    out_tint: 17.607929229736328,
    temp: 3200.0,
    tint: -44.0,
    version: 'V2',
  },
  {
    out_temp: 5696.3935546875,
    out_tint: -5.037506103515625,
    temp: 5700.0,
    tint: 50.0,
    version: 'V2',
  },
  {
    out_temp: 5522.8603515625,
    out_tint: 53.35565948486328,
    temp: 5520.0,
    tint: -144.0,
    version: 'V2',
  },
  {
    out_temp: 5523.68798828125,
    out_tint: 26.055063247680664,
    temp: 5520.0,
    tint: -53.0,
    version: 'V2',
  },
  {
    out_temp: 6454.1572265625,
    out_tint: 9.982888221740723,
    temp: 6500.0,
    tint: 0.0,
    version: 'V3',
  },
  {
    out_temp: 5024.43603515625,
    out_tint: 12.819326400756836,
    temp: 5000.0,
    tint: 10.0,
    version: 'V3',
  },
  {
    out_temp: 3240.382568359375,
    out_tint: -8.740213394165039,
    temp: 3200.0,
    tint: -44.0,
    version: 'V3',
  },
  {
    out_temp: 5697.5654296875,
    out_tint: 24.960861206054688,
    temp: 5700.0,
    tint: 50.0,
    version: 'V3',
  },
  {
    out_temp: 5526.06787109375,
    out_tint: -33.04674530029297,
    temp: 5520.0,
    tint: -144.0,
    version: 'V3',
  },
  {
    out_temp: 5524.8505859375,
    out_tint: -5.745927333831787,
    temp: 5520.0,
    tint: -53.0,
    version: 'V3',
  },
  {
    out_temp: 6454.1572265625,
    out_tint: 9.982888221740723,
    temp: 6500.0,
    tint: 0.0,
    version: 'V4',
  },
  {
    out_temp: 5022.5712890625,
    out_tint: 19.8153076171875,
    temp: 5000.0,
    tint: 10.0,
    version: 'V4',
  },
  {
    out_temp: 3266.525146484375,
    out_tint: -39.48410415649414,
    temp: 3200.0,
    tint: -44.0,
    version: 'V4',
  },
  {
    out_temp: 5698.6875,
    out_tint: 59.95922088623047,
    temp: 5700.0,
    tint: 50.0,
    version: 'V4',
  },
  {
    out_temp: 5534.02294921875,
    out_tint: -133.85308837890625,
    temp: 5520.0,
    tint: -144.0,
    version: 'V4',
  },
  {
    out_temp: 5526.5673828125,
    out_tint: -42.84722137451172,
    temp: 5520.0,
    tint: -53.0,
    version: 'V4',
  },
];

const VERSION_NUMBER: Record<'V1' | 'V2' | 'V3' | 'V4', number> = { V1: 1, V2: 2, V3: 3, V4: 4 };

describe('wb-dng-temperature (#1894 golden vectors)', () => {
  describe('tempTintToXy', () => {
    for (const v of TEMP_TINT_TO_XY) {
      it(`temp=${v.temp} tint=${v.tint} -> xy within 1e-6`, () => {
        const [x, y] = tempTintToXy(v.temp, v.tint);
        expect(Math.abs(x - v.x)).toBeLessThan(1e-6);
        expect(Math.abs(y - v.y)).toBeLessThan(1e-6);
      });
    }
  });

  describe('xyToTempTint', () => {
    for (const v of XY_TO_TEMP_TINT) {
      it(`x=${v.x} y=${v.y} -> temp within 0.05K, tint within 0.005`, () => {
        const [temp, tint] = xyToTempTint(v.x, v.y);
        expect(Math.abs(temp - v.temp)).toBeLessThan(0.05);
        expect(Math.abs(tint - v.tint)).toBeLessThan(0.005);
      });
    }
  });

  describe('authoredPairToV5', () => {
    for (const v of AUTHORED_PAIR_TO_V5) {
      it(`${v.version} temp=${v.temp} tint=${v.tint} -> V5 pair within 0.05K/0.005 tint`, () => {
        const [outTemp, outTint] = authoredPairToV5(v.temp, v.tint, VERSION_NUMBER[v.version]);
        expect(Math.abs(outTemp - v.out_temp)).toBeLessThan(0.05);
        expect(Math.abs(outTint - v.out_tint)).toBeLessThan(0.005);
      });
    }
  });

  // #1922: a non-positive, zero, or non-finite temperature (from a corrupt or
  // hand-edited sidecar) must never yield NaN/Infinity or a
  // physically-impossible chromaticity. Mirrors raw-core's
  // `degenerate_temperature_stays_finite_and_in_gamut`.
  describe('degenerate temperature clamp', () => {
    const temps = [0, -1, -6500, NaN, Infinity, -Infinity];
    const tints = [-120, 0, 120];
    for (const temp of temps) {
      for (const tint of tints) {
        it(`temp=${temp} tint=${tint} -> finite, in-gamut xy`, () => {
          const [x, y] = tempTintToXy(temp, tint);
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          expect(x > 0 && x < 1 && y > 0 && y < 1).toBe(true);
        });
      }
    }
  });
});

// #4630: independent Adobe SDK inverse vectors, with f32 input coordinates.
// No Rust-generated expectations in this regression.
describe('SDK interpolated-locus tint vectors', () => {
  const vectors = [
    [0.3838279545, 0.2841948271, 2850.00058229, -149.999972428],
    [0.4479934871, 0.4075490534, 2850.00026714, -3.46694376647e-7],
    [0.5525931716, 0.6086354256, 2850.0001756, 149.999994034],
    [0.3569014966, 0.2738821208, 3750.00376995, -149.999969103],
    [0.3920486271, 0.3834866583, 3750.00150229, -2.07143283309e-5],
    [0.4474169016, 0.5561499, 3750.00105704, 149.999992462],
    [0.3317653835, 0.2580831051, 5499.96735567, -149.999993431],
    [0.3324049115, 0.3408484161, 5499.98326189, -1.27400630356e-5],
    [0.333330065, 0.4605805874, 5499.98900471, 149.999993095],
    [0.3235426247, 0.2515083849, 6500.01898299, -149.999966492],
    [0.3135279119, 0.3235340714, 6500.00952617, -7.71069934712e-6],
    [0.299565345, 0.4239527583, 6500.00591603, 149.999983649],
    [0.3127032518, 0.241643548, 8499.92739773, -150.000009327],
    [0.2908171117, 0.2998214066, 8499.95921999, 1.45074321421e-5],
    [0.2617659271, 0.3770454228, 8499.97175487, 150.000002846],
    [0.3024311364, 0.2312981039, 11999.990903, -150.000030601],
    [0.2718083262, 0.2775730789, 11999.9960281, -2.65001955717e-6],
    [0.2328940779, 0.3363775015, 11999.9965638, 149.999992152],
  ];
  for (const [x, y, temperature, tint] of vectors) {
    it(`SDK xy ${x},${y}`, () => {
      const actual = xyToTempTint(x, y);
      expect(Math.abs(actual[0] - temperature)).toBeLessThan(0.005);
      expect(Math.abs(actual[1] - tint)).toBeLessThan(0.0001);
    });
  }
});
