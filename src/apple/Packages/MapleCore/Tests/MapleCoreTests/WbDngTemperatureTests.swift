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
        (x: 0.44881463050842285, y: 0.3330320119857788, temp: 2199.999755859375, tint: -89.796875),
        (x: 0.5055774450302124, y: 0.4151369333267212, temp: 2199.999755859375, tint: 0.20312435925006866),
        (x: 0.5363673567771912, y: 0.4596731960773468, temp: 2200.0, tint: 40.20314407348633),
        (x: 0.4059551954269409, y: 0.32726213335990906, temp: 2855.999755859375, tint: -89.33100128173828),
        (x: 0.4475476145744324, y: 0.407437264919281, temp: 2856.0, tint: 0.6689776182174683),
        (x: 0.4701326787471771, y: 0.4509730935096741, temp: 2856.0, tint: 40.66897964477539),
        (x: 0.3619736433029175, y: 0.30864250659942627, temp: 3999.999755859375, tint: -88.9583511352539),
        (x: 0.3804461658000946, y: 0.3767562508583069, temp: 4000.000244140625, tint: 2.2031133994460106e-05),
        (x: 0.3902992010116577, y: 0.41308727860450745, temp: 4000.0, tint: 41.041629791259766),
        (x: 0.33996671438217163, y: 0.29419222474098206, temp: 5000.0009765625, tint: -89.99999237060547),
        (x: 0.3451041281223297, y: 0.3516225218772888, temp: 5000.00048828125, tint: 1.690994031378068e-05),
        (x: 0.3477909564971924, y: 0.38165807723999023, temp: 5000.00048828125, tint: 40.0000114440918),
        (x: 0.3198969066143036, y: 0.2777283787727356, temp: 6500.01318359375, tint: -89.25637817382812),
        (x: 0.313527911901474, y: 0.3235340714454651, temp: 6500.009765625, tint: 0.7436093688011169),
        (x: 0.31027477979660034, y: 0.3469306230545044, temp: 6500.0078125, tint: 40.743629455566406),
        (x: 0.3076633810997009, y: 0.26627570390701294, temp: 7999.9990234375, tint: -88.80708312988281),
        (x: 0.2951829135417938, y: 0.30476856231689453, temp: 8000.0, tint: 1.192937970161438),
        (x: 0.2889087498188019, y: 0.3241196572780609, temp: 7999.99951171875, tint: 41.19293212890625),
        (x: 0.2909998297691345, y: 0.24857226014137268, temp: 11999.994140625, tint: -89.9697036743164),
        (x: 0.27180832624435425, y: 0.2775730788707733, temp: 11999.99609375, tint: 0.030284959822893143),
        (x: 0.262368381023407, y: 0.29183804988861084, temp: 11999.99609375, tint: 40.03028869628906),
        (x: 0.27914875745773315, y: 0.23461896181106567, temp: 20000.0, tint: -89.99998474121094),
        (x: 0.25645267963409424, y: 0.2576335072517395, temp: 20000.009765625, tint: 1.2805227925127838e-05),
        (x: 0.24544940888881683, y: 0.26879119873046875, temp: 20000.00390625, tint: 39.999996185302734),
    ]

    static let authoredPairToV5Vectors: [(version: Int, temp: Double, tint: Double, outTemp: Double, outTint: Double)] = [
        (version: 1, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 10.601079940795898),
        (version: 1, temp: 5000.0, tint: 10.0, outTemp: 5024.43603515625, outTint: 12.773890495300293),
        (version: 1, temp: 3200.0, tint: -44.0, outTemp: 3240.382568359375, outTint: -8.558677673339844),
        (version: 2, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 10.601079940795898),
        (version: 2, temp: 5000.0, tint: 10.0, outTemp: 5026.10302734375, outTint: 6.774545669555664),
        (version: 2, temp: 3200.0, tint: -44.0, outTemp: 3221.401611328125, outTint: 17.697181701660156),
        (version: 3, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 10.601079940795898),
        (version: 3, temp: 5000.0, tint: 10.0, outTemp: 5024.43603515625, outTint: 12.773890495300293),
        (version: 3, temp: 3200.0, tint: -44.0, outTemp: 3240.382568359375, outTint: -8.558677673339844),
        (version: 4, temp: 6500.0, tint: 0.0, outTemp: 6454.1572265625, outTint: 10.601079940795898),
        (version: 4, temp: 5000.0, tint: 10.0, outTemp: 5022.5712890625, outTint: 19.773061752319336),
        (version: 4, temp: 3200.0, tint: -44.0, outTemp: 3266.525146484375, outTint: -39.148414611816406),
    ]

    // MARK: - Tests

    func testTempTintToXyMatchesGoldenVectors() {
        for v in Self.tempTintToXyVectors {
            let (x, y) = WbDngTemperature.tempTintToXy(v.temp, v.tint)
            XCTAssertEqual(x, v.x, accuracy: 1e-6,
                            "temp=\(v.temp) tint=\(v.tint): x mismatch")
            XCTAssertEqual(y, v.y, accuracy: 1e-6,
                            "temp=\(v.temp) tint=\(v.tint): y mismatch")
        }
    }

    func testXyToTempTintMatchesGoldenVectors() {
        for v in Self.xyToTempTintVectors {
            let (temp, tint) = WbDngTemperature.xyToTempTint(v.x, v.y)
            XCTAssertEqual(temp, v.temp, accuracy: 0.05,
                            "x=\(v.x) y=\(v.y): temperature mismatch")
            XCTAssertEqual(tint, v.tint, accuracy: 0.005,
                            "x=\(v.x) y=\(v.y): tint mismatch")
        }
    }

    func testAuthoredPairToV5MatchesGoldenVectors() {
        for v in Self.authoredPairToV5Vectors {
            let (outTemp, outTint) = WbDngTemperature.authoredPairToV5(
                temperature: v.temp, tint: v.tint, version: v.version)
            XCTAssertEqual(outTemp, v.outTemp, accuracy: 0.05,
                            "version=\(v.version) temp=\(v.temp) tint=\(v.tint): out temperature mismatch")
            XCTAssertEqual(outTint, v.outTint, accuracy: 0.005,
                            "version=\(v.version) temp=\(v.temp) tint=\(v.tint): out tint mismatch")
        }
    }
}
