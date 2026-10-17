// WbDngTemperatureTests.swift — pins `WbDngTemperature`'s Robertson
// mapping + legacy Hernández-Andrés map + `authoredPairToV5` against golden
// vectors generated from the Rust reference implementation
// (`raw-core/src/color/dng_temperature.rs`'s
// `golden_vectors_for_cross_language_ports` test, #1894 design comment
// item 8).
//
// Tests cannot read arbitrary filesystem paths (the golden vectors were
// generated to a scratch location outside the repo), so the vectors are
// embedded here as Swift literals — copied verbatim (full f64-widened
// precision) from the generated JSON. Do not hand-edit these tables; if
// the Rust reference's math or table changes, regenerate the JSON from
// `cargo test -p raw-core --lib golden_vectors_for_cross_language_ports`
// and re-paste.
//
// Tolerances (per the #1894 design comment):
//  - `temp_tint_to_xy` (forward): x/y within 1e-6.
//  - `xy_to_temp_tint` (inverse): temperature within 0.05 K, tint within
//    0.005.
//  - `authored_pair_to_v5`: temperature within 0.05 K, tint within 0.005.

import XCTest

@testable import MapleCore

final class WbDngTemperatureTests: XCTestCase {

  // MARK: - Golden vectors (from Rust, verbatim)

  static let tempTintToXyVectors: [(temp: Double, tint: Double, x: Double, y: Double)] = [
    (temp: 2200.0, tint: -90.0, x: 0.44881463050842285, y: 0.3330320119857788),
    (temp: 2200.0, tint: 0.0, x: 0.5055774450302124, y: 0.4151369333267212),
    (temp: 2200.0, tint: 40.0, x: 0.5363673567771912, y: 0.4596731960773468),
    (temp: 2856.0, tint: -90.0, x: 0.4059551954269409, y: 0.32726213335990906),
    (temp: 2856.0, tint: 0.0, x: 0.4475476145744324, y: 0.407437264919281),
    (temp: 2856.0, tint: 40.0, x: 0.4701326787471771, y: 0.4509730935096741),
    (temp: 4000.0, tint: -90.0, x: 0.3619736433029175, y: 0.30864250659942627),
    (temp: 4000.0, tint: 0.0, x: 0.3804461658000946, y: 0.3767562508583069),
    (temp: 4000.0, tint: 40.0, x: 0.3902992010116577, y: 0.41308727860450745),
    (temp: 5000.0, tint: -90.0, x: 0.33996671438217163, y: 0.29419222474098206),
    (temp: 5000.0, tint: 0.0, x: 0.3451041281223297, y: 0.3516225218772888),
    (temp: 5000.0, tint: 40.0, x: 0.3477909564971924, y: 0.38165807723999023),
    (temp: 6500.0, tint: -90.0, x: 0.3198969066143036, y: 0.2777283787727356),
    (temp: 6500.0, tint: 0.0, x: 0.313527911901474, y: 0.3235340714454651),
    (temp: 6500.0, tint: 40.0, x: 0.31027477979660034, y: 0.3469306230545044),
    (temp: 8000.0, tint: -90.0, x: 0.3076633810997009, y: 0.26627570390701294),
    (temp: 8000.0, tint: 0.0, x: 0.2951829135417938, y: 0.30476856231689453),
    (temp: 8000.0, tint: 40.0, x: 0.2889087498188019, y: 0.3241196572780609),
    (temp: 12000.0, tint: -90.0, x: 0.2909998297691345, y: 0.24857226014137268),
    (temp: 12000.0, tint: 0.0, x: 0.27180832624435425, y: 0.2775730788707733),
    (temp: 12000.0, tint: 40.0, x: 0.262368381023407, y: 0.29183804988861084),
    (temp: 20000.0, tint: -90.0, x: 0.27914875745773315, y: 0.23461896181106567),
    (temp: 20000.0, tint: 0.0, x: 0.25645267963409424, y: 0.2576335072517395),
    (temp: 20000.0, tint: 40.0, x: 0.24544940888881683, y: 0.26879119873046875),
  ]

  static let xyToTempTintVectors: [(x: Double, y: Double, temp: Double, tint: Double)] = [
    (
      x: 0.44881463050842285, y: 0.3330320119857788, temp: 2199.999755859375,
      tint: -90.00000762939453
    ),
    (
      x: 0.5055774450302124, y: 0.4151369333267212, temp: 2199.999755859375,
      tint: -9.548301932227332e-06
    ),
    (x: 0.5363673567771912, y: 0.4596731960773468, temp: 2200.0, tint: 40.00000762939453),
    (
      x: 0.4059551954269409, y: 0.32726213335990906, temp: 2855.999755859375,
      tint: -89.99999237060547
    ),
    (x: 0.4475476145744324, y: 0.407437264919281, temp: 2856.0, tint: -1.5299507140298374e-05),
    (x: 0.4701326787471771, y: 0.4509730935096741, temp: 2856.0, tint: 39.9999885559082),
    (
      x: 0.3619736433029175, y: 0.30864250659942627, temp: 3999.999755859375,
      tint: -89.99999237060547
    ),
    (
      x: 0.3804461658000946, y: 0.3767562508583069, temp: 4000.000244140625,
      tint: 2.2742271539755166e-05
    ),
    (x: 0.3902992010116577, y: 0.41308727860450745, temp: 4000.0, tint: 39.99999237060547),
    (
      x: 0.33996671438217163, y: 0.29419222474098206, temp: 5000.0009765625,
      tint: -89.99999237060547
    ),
    (
      x: 0.3451041281223297, y: 0.3516225218772888, temp: 5000.00048828125,
      tint: 1.7960110199055634e-05
    ),
    (x: 0.3477909564971924, y: 0.38165807723999023, temp: 5000.00048828125, tint: 40.0000114440918),
    (
      x: 0.3198969066143036, y: 0.2777283787727356, temp: 6500.01318359375, tint: -90.00000762939453
    ),
    (
      x: 0.313527911901474, y: 0.3235340714454651, temp: 6500.009765625,
      tint: -7.710699719609693e-06
    ),
    (x: 0.31027477979660034, y: 0.3469306230545044, temp: 6500.0078125, tint: 40.00001907348633),
    (
      x: 0.3076633810997009, y: 0.26627570390701294, temp: 7999.9990234375, tint: -89.99999237060547
    ),
    (x: 0.2951829135417938, y: 0.30476856231689453, temp: 8000.0, tint: 2.4420609406661242e-05),
    (x: 0.2889087498188019, y: 0.3241196572780609, temp: 7999.99951171875, tint: 40.00001907348633),
    (
      x: 0.2909998297691345, y: 0.24857226014137268, temp: 11999.994140625, tint: -89.99998474121094
    ),
    (
      x: 0.27180832624435425, y: 0.2775730788707733, temp: 11999.99609375,
      tint: -2.6500194962864043e-06
    ),
    (x: 0.262368381023407, y: 0.29183804988861084, temp: 11999.99609375, tint: 40.0),
    (x: 0.27914875745773315, y: 0.23461896181106567, temp: 20000.0, tint: -89.99998474121094),
    (
      x: 0.25645267963409424, y: 0.2576335072517395, temp: 20000.009765625,
      tint: 1.3056283933110535e-05
    ),
    (
      x: 0.24544940888881683, y: 0.26879119873046875, temp: 20000.00390625, tint: 39.999996185302734
    ),
  ]

  static let authoredPairToV5Vectors:
    [(version: Int, temp: Double, tint: Double, outTemp: Double, outTint: Double)] = [
      (version: 1, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 9.982888221740723),
      (
        version: 1, temp: 5000.0, tint: 10.0, outTemp: 5024.43603515625, outTint: 12.819326400756836
      ),
      (
        version: 1, temp: 3200.0, tint: -44.0, outTemp: 3240.382568359375,
        outTint: -8.740213394165039
      ),
      (version: 1, temp: 5700.0, tint: 50.0, outTemp: 5697.5654296875, outTint: 24.960861206054688),
      (
        version: 1, temp: 5520.0, tint: -144.0, outTemp: 5526.06787109375,
        outTint: -33.04674530029297
      ),
      (
        version: 1, temp: 5520.0, tint: -53.0, outTemp: 5524.8505859375, outTint: -5.745927333831787
      ),
      (version: 2, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 9.982888221740723),
      (version: 2, temp: 5000.0, tint: 10.0, outTemp: 5026.10302734375, outTint: 6.82279634475708),
      (
        version: 2, temp: 3200.0, tint: -44.0, outTemp: 3221.401611328125,
        outTint: 17.607929229736328
      ),
      (version: 2, temp: 5700.0, tint: 50.0, outTemp: 5696.3935546875, outTint: -5.037506103515625),
      (
        version: 2, temp: 5520.0, tint: -144.0, outTemp: 5522.8603515625, outTint: 53.35565948486328
      ),
      (
        version: 2, temp: 5520.0, tint: -53.0, outTemp: 5523.68798828125,
        outTint: 26.055063247680664
      ),
      (version: 3, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 9.982888221740723),
      (
        version: 3, temp: 5000.0, tint: 10.0, outTemp: 5024.43603515625, outTint: 12.819326400756836
      ),
      (
        version: 3, temp: 3200.0, tint: -44.0, outTemp: 3240.382568359375,
        outTint: -8.740213394165039
      ),
      (version: 3, temp: 5700.0, tint: 50.0, outTemp: 5697.5654296875, outTint: 24.960861206054688),
      (
        version: 3, temp: 5520.0, tint: -144.0, outTemp: 5526.06787109375,
        outTint: -33.04674530029297
      ),
      (
        version: 3, temp: 5520.0, tint: -53.0, outTemp: 5524.8505859375, outTint: -5.745927333831787
      ),
      (version: 4, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 9.982888221740723),
      (version: 4, temp: 5000.0, tint: 10.0, outTemp: 5022.5712890625, outTint: 19.8153076171875),
      (
        version: 4, temp: 3200.0, tint: -44.0, outTemp: 3266.525146484375,
        outTint: -39.48410415649414
      ),
      (version: 4, temp: 5700.0, tint: 50.0, outTemp: 5698.6875, outTint: 59.95922088623047),
      (
        version: 4, temp: 5520.0, tint: -144.0, outTemp: 5534.02294921875,
        outTint: -133.85308837890625
      ),
      (
        version: 4, temp: 5520.0, tint: -53.0, outTemp: 5526.5673828125, outTint: -42.84722137451172
      ),
    ]

  // MARK: - Tests

  func testTempTintToXyMatchesGoldenVectors() {
    for v in Self.tempTintToXyVectors {
      let (x, y) = WbDngTemperature.tempTintToXy(v.temp, v.tint)
      XCTAssertEqual(
        x, v.x, accuracy: 1e-6,
        "temp=\(v.temp) tint=\(v.tint): x mismatch")
      XCTAssertEqual(
        y, v.y, accuracy: 1e-6,
        "temp=\(v.temp) tint=\(v.tint): y mismatch")
    }
  }

  func testXyToTempTintMatchesGoldenVectors() {
    for v in Self.xyToTempTintVectors {
      let (temp, tint) = WbDngTemperature.xyToTempTint(v.x, v.y)
      XCTAssertEqual(
        temp, v.temp, accuracy: 0.05,
        "x=\(v.x) y=\(v.y): temperature mismatch")
      XCTAssertEqual(
        tint, v.tint, accuracy: 0.005,
        "x=\(v.x) y=\(v.y): tint mismatch")
    }
  }

  func testAuthoredPairToV5MatchesGoldenVectors() {
    for v in Self.authoredPairToV5Vectors {
      let (outTemp, outTint) = WbDngTemperature.authoredPairToV5(
        temperature: v.temp, tint: v.tint, version: v.version)
      XCTAssertEqual(
        outTemp, v.outTemp, accuracy: 0.05,
        "version=\(v.version) temp=\(v.temp) tint=\(v.tint): out temperature mismatch")
      XCTAssertEqual(
        outTint, v.outTint, accuracy: 0.005,
        "version=\(v.version) temp=\(v.temp) tint=\(v.tint): out tint mismatch")
    }
  }

  /// #1922: a non-positive, zero, or non-finite temperature (from a corrupt
  /// or hand-edited sidecar) must never yield NaN/Inf or a
  /// physically-impossible chromaticity. Mirrors raw-core's
  /// `degenerate_temperature_stays_finite_and_in_gamut`.
  func testDegenerateTemperatureStaysFiniteAndInGamut() {
    let temps: [Double] = [0.0, -1.0, -6500.0, .nan, .infinity, -.infinity]
    let tints: [Double] = [-120.0, 0.0, 120.0]
    for temp in temps {
      for tint in tints {
        let (x, y) = WbDngTemperature.tempTintToXy(temp, tint)
        XCTAssertTrue(
          x.isFinite && y.isFinite,
          "temp=\(temp) tint=\(tint) produced non-finite xy (\(x), \(y))")
        XCTAssertTrue(
          x > 0.0 && x < 1.0 && y > 0.0 && y < 1.0,
          "temp=\(temp) tint=\(tint) produced out-of-range xy (\(x), \(y))")
      }
    }
  }
}

// #4630: independent Adobe SDK output on the same f32 input coordinates.
extension WbDngTemperatureTests {
  func testInverseMatchesAdobeSdkVectors() {
    let vectors: [(Double, Double, Double, Double)] = [
      (0.3838279545, 0.2841948271, 2850.00058229, -149.999972428),
      (0.4479934871, 0.4075490534, 2850.00026714, -3.46694376647e-07),
      (0.5525931716, 0.6086354256, 2850.0001756, 149.999994034),
      (0.3569014966, 0.2738821208, 3750.00376995, -149.999969103),
      (0.3920486271, 0.3834866583, 3750.00150229, -2.07143283309e-05),
      (0.4474169016, 0.5561499, 3750.00105704, 149.999992462),
      (0.3317653835, 0.2580831051, 5499.96735567, -149.999993431),
      (0.3324049115, 0.3408484161, 5499.98326189, -1.27400630356e-05),
      (0.333330065, 0.4605805874, 5499.98900471, 149.999993095),
      (0.3235426247, 0.2515083849, 6500.01898299, -149.999966492),
      (0.3135279119, 0.3235340714, 6500.00952617, -7.71069934712e-06),
      (0.299565345, 0.4239527583, 6500.00591603, 149.999983649),
      (0.3127032518, 0.241643548, 8499.92739773, -150.000009327),
      (0.2908171117, 0.2998214066, 8499.95921999, 1.45074321421e-05),
      (0.2617659271, 0.3770454228, 8499.97175487, 150.000002846),
      (0.3024311364, 0.2312981039, 11999.990903, -150.000030601),
      (0.2718083262, 0.2775730789, 11999.9960281, -2.65001955717e-06),
      (0.2328940779, 0.3363775015, 11999.9965638, 149.999992152),
    ]
    for (x, y, temperature, tint) in vectors {
      let actual = WbDngTemperature.xyToTempTint(x, y)
      XCTAssertEqual(actual.temperature, temperature, accuracy: 0.005)
      XCTAssertEqual(actual.tint, tint, accuracy: 0.0001)
    }
  }
}
