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
  { x: 0.44881463050842285, y: 0.3330320119857788, temp: 2199.999755859375, tint: -89.796875 },
  {
    x: 0.5055774450302124,
    y: 0.4151369333267212,
    temp: 2199.999755859375,
    tint: 0.20312435925006866,
  },
  { x: 0.5363673567771912, y: 0.4596731960773468, temp: 2200.0, tint: 40.20314407348633 },
  {
    x: 0.4059551954269409,
    y: 0.32726213335990906,
    temp: 2855.999755859375,
    tint: -89.33100128173828,
  },
  { x: 0.4475476145744324, y: 0.407437264919281, temp: 2856.0, tint: 0.6689776182174683 },
  { x: 0.4701326787471771, y: 0.4509730935096741, temp: 2856.0, tint: 40.66897964477539 },
  {
    x: 0.3619736433029175,
    y: 0.30864250659942627,
    temp: 3999.999755859375,
    tint: -88.9583511352539,
  },
  {
    x: 0.3804461658000946,
    y: 0.3767562508583069,
    temp: 4000.000244140625,
    tint: 0.000022031133994460106,
  },
  { x: 0.3902992010116577, y: 0.41308727860450745, temp: 4000.0, tint: 41.041629791259766 },
  {
    x: 0.33996671438217163,
    y: 0.29419222474098206,
    temp: 5000.0009765625,
    tint: -89.99999237060547,
  },
  {
    x: 0.3451041281223297,
    y: 0.3516225218772888,
    temp: 5000.00048828125,
    tint: 0.00001690994031378068,
  },
  { x: 0.3477909564971924, y: 0.38165807723999023, temp: 5000.00048828125, tint: 40.0000114440918 },
  {
    x: 0.3198969066143036,
    y: 0.2777283787727356,
    temp: 6500.01318359375,
    tint: -89.25637817382812,
  },
  { x: 0.313527911901474, y: 0.3235340714454651, temp: 6500.009765625, tint: 0.7436093688011169 },
  { x: 0.31027477979660034, y: 0.3469306230545044, temp: 6500.0078125, tint: 40.743629455566406 },
  {
    x: 0.3076633810997009,
    y: 0.26627570390701294,
    temp: 7999.9990234375,
    tint: -88.80708312988281,
  },
  { x: 0.2951829135417938, y: 0.30476856231689453, temp: 8000.0, tint: 1.192937970161438 },
  { x: 0.2889087498188019, y: 0.3241196572780609, temp: 7999.99951171875, tint: 41.19293212890625 },
  { x: 0.2909998297691345, y: 0.24857226014137268, temp: 11999.994140625, tint: -89.9697036743164 },
  {
    x: 0.27180832624435425,
    y: 0.2775730788707733,
    temp: 11999.99609375,
    tint: 0.030284959822893143,
  },
  { x: 0.262368381023407, y: 0.29183804988861084, temp: 11999.99609375, tint: 40.03028869628906 },
  { x: 0.27914875745773315, y: 0.23461896181106567, temp: 20000.0, tint: -89.99998474121094 },
  {
    x: 0.25645267963409424,
    y: 0.2576335072517395,
    temp: 20000.009765625,
    tint: 0.000012805227925127838,
  },
  {
    x: 0.24544940888881683,
    y: 0.26879119873046875,
    temp: 20000.00390625,
    tint: 39.999996185302734,
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
    version: 'V1',
    temp: 6500.0,
    tint: 0.0,
    out_temp: 6454.1572265625,
    out_tint: 10.601079940795898,
  },
  {
    version: 'V1',
    temp: 5000.0,
    tint: 10.0,
    out_temp: 5024.43603515625,
    out_tint: 12.773890495300293,
  },
  {
    version: 'V1',
    temp: 3200.0,
    tint: -44.0,
    out_temp: 3240.382568359375,
    out_tint: -8.558677673339844,
  },
  {
    version: 'V2',
    temp: 6500.0,
    tint: 0.0,
    out_temp: 6454.1572265625,
    out_tint: 10.601079940795898,
  },
  {
    version: 'V2',
    temp: 5000.0,
    tint: 10.0,
    out_temp: 5026.10302734375,
    out_tint: 6.774545669555664,
  },
  {
    version: 'V2',
    temp: 3200.0,
    tint: -44.0,
    out_temp: 3221.401611328125,
    out_tint: 17.697181701660156,
  },
  {
    version: 'V3',
    temp: 6500.0,
    tint: 0.0,
    out_temp: 6454.1572265625,
    out_tint: 10.601079940795898,
  },
  {
    version: 'V3',
    temp: 5000.0,
    tint: 10.0,
    out_temp: 5024.43603515625,
    out_tint: 12.773890495300293,
  },
  {
    version: 'V3',
    temp: 3200.0,
    tint: -44.0,
    out_temp: 3240.382568359375,
    out_tint: -8.558677673339844,
  },
  {
    version: 'V4',
    temp: 6500.0,
    tint: 0.0,
    out_temp: 6454.1572265625,
    out_tint: 10.601079940795898,
  },
  {
    version: 'V4',
    temp: 5000.0,
    tint: 10.0,
    out_temp: 5022.5712890625,
    out_tint: 19.773061752319336,
  },
  {
    version: 'V4',
    temp: 3200.0,
    tint: -44.0,
    out_temp: 3266.525146484375,
    out_tint: -39.148414611816406,
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
});
