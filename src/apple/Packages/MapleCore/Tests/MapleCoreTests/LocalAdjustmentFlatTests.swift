import XCTest

@testable import MapleCore

final class LocalAdjustmentFlatTests: XCTestCase {
    private func loadFixtureLayers() throws -> [LocalAdjustment] {
        let url = Bundle.module.url(forResource: "layer-stack", withExtension: "json")!
        let data = try Data(contentsOf: url)
        struct Wire: Decodable {
            struct MaskWire: Decodable {
                let kind: String
                let start: [Double]?
                let end: [Double]?
                let center: [Double]?
                let radii: [Double]?
                let angle: Double?
                let feather: Double?
                let invert: Bool?
                let raster_id: UInt32?
                let digest: String?
            }
            struct RangeWire: Decodable {
                let hueDeg: Double
                let hueHalfWidthDeg: Double
                let chromaMin: Double
                let lMin: Double
                let lMax: Double
                let feather: Double
            }
            struct AdjWire: Decodable {
                let exposure: Double?
                let contrast: Double?
                let highlights: Double?
                let shadows: Double?
                let whites: Double?
                let blacks: Double?
                let saturation: Double?
                let vibrance: Double?
                let temperature: Double?
                let tint: Double?
                let hue: Double?
            }
            struct Layer: Decodable {
                let mask: MaskWire
                let range: RangeWire?
                let adjustments: AdjWire
            }
            let layers: [Layer]
        }
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        return wire.layers.map { l in
            let mask: LocalMask
            switch l.mask.kind {
            case "linear":
                mask = .linear(
                    start: MaskPoint(x: l.mask.start![0], y: l.mask.start![1]),
                    end: MaskPoint(x: l.mask.end![0], y: l.mask.end![1]), feather: l.mask.feather!
                )
            case "radial":
                mask = .radial(
                    center: MaskPoint(x: l.mask.center![0], y: l.mask.center![1]),
                    radii: MaskPoint(x: l.mask.radii![0], y: l.mask.radii![1]),
                    angle: l.mask.angle!, feather: l.mask.feather!, invert: l.mask.invert!
                )
            case "bitmap":
                mask = .bitmap(
                    recipe: BitmapRecipe(person: 0, facialSkin: true, bodySkin: true, model: "", digest: l.mask.digest!),
                    rasterId: l.mask.raster_id ?? 0
                )
            default:
                mask = .everywhere
            }
            let range = l.range.map {
                RangeRefinement.color(
                    hueDeg: $0.hueDeg, hueHalfWidthDeg: $0.hueHalfWidthDeg, chromaMin: $0.chromaMin,
                    lMin: $0.lMin, lMax: $0.lMax, feather: $0.feather
                )
            }
            let a = l.adjustments
            let adjustments = PartialAdjustments(
                exposure: a.exposure, contrast: a.contrast, highlights: a.highlights, shadows: a.shadows,
                whites: a.whites, blacks: a.blacks, saturation: a.saturation, vibrance: a.vibrance,
                temperature: a.temperature, tint: a.tint, hue: a.hue
            )
            return LocalAdjustment(mask: mask, range: range, adjustments: adjustments)
        }
    }

    func testFixtureLayerStackRoundTripsThroughTheFlatWire() throws {
        let layers = try loadFixtureLayers()
        let flat = LocalAdjustmentFlat.toFlat(layers)
        XCTAssertEqual(flat.count, layers.count * 32)
        // Layer 0 (linear, exposure+shadows) — matches the Rust fixture test.
        XCTAssertEqual(Array(flat[0..<5]), [0.1, 0.2, 0.9, 0.8, 0.4].map(Float.init))
        XCTAssertEqual(flat[12], 0.5)
        XCTAssertEqual(flat[15], -20.0)
        let digests: [UInt32: String] = [0: "0011223344556677"]  // bitmap layer's raster resolved to id 0 for the round trip
        let back = LocalAdjustmentFlat.fromFlat(flat, rasterDigests: digests)
        XCTAssertEqual(back.count, layers.count)
        // The wire is Float32 while the model is Double, so a round trip
        // through it is lossy for values with no exact binary32
        // representation (0.1, 0.9, 0.02, 0.95, …) — compare with a
        // tolerance rather than `==`, the same reason the Rust-side flat
        // tests only assert exact equality on f32-native values.
        guard case .linear(let start, let end, let feather) = back[0].mask,
            case .linear(let wantStart, let wantEnd, let wantFeather) = layers[0].mask
        else {
            return XCTFail("expected .linear on both sides")
        }
        XCTAssertEqual(start.x, wantStart.x, accuracy: 1e-5)
        XCTAssertEqual(start.y, wantStart.y, accuracy: 1e-5)
        XCTAssertEqual(end.x, wantEnd.x, accuracy: 1e-5)
        XCTAssertEqual(end.y, wantEnd.y, accuracy: 1e-5)
        XCTAssertEqual(feather, wantFeather, accuracy: 1e-5)
        XCTAssertEqual(back[0].adjustments, layers[0].adjustments)
        guard case .color(let hueDeg, let halfWidth, let chromaMin, let lMin, let lMax, let rangeFeather) = back[1].range,
            case .color(
                let wantHueDeg, let wantHalfWidth, let wantChromaMin, let wantLMin, let wantLMax, let wantRangeFeather
            ) = layers[1].range
        else {
            return XCTFail("expected .color range on both sides")
        }
        XCTAssertEqual(hueDeg, wantHueDeg, accuracy: 1e-5)
        XCTAssertEqual(halfWidth, wantHalfWidth, accuracy: 1e-5)
        XCTAssertEqual(chromaMin, wantChromaMin, accuracy: 1e-5)
        XCTAssertEqual(lMin, wantLMin, accuracy: 1e-5)
        XCTAssertEqual(lMax, wantLMax, accuracy: 1e-5)
        XCTAssertEqual(rangeFeather, wantRangeFeather, accuracy: 1e-5)
        XCTAssertEqual(back[3].mask, .everywhere)
    }

    func testHueRidesSlot22WithPresenceBit1024() {
        let layer = LocalAdjustment(mask: .everywhere, range: nil, adjustments: PartialAdjustments(hue: -42.5))
        let flat = LocalAdjustmentFlat.toFlat([layer])
        XCTAssertEqual(flat[22], -42.5)
        XCTAssertEqual(Int(flat[8]), 1 << 10)
    }

    func testAbsentRangeReadsBackAsNil() {
        let layer = LocalAdjustment(
            mask: .linear(start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 0), feather: 0.5), range: nil,
            adjustments: PartialAdjustments()
        )
        let flat = LocalAdjustmentFlat.toFlat([layer])
        XCTAssertEqual(flat[24], 0.0)
        XCTAssertNil(LocalAdjustmentFlat.fromFlat(flat, rasterDigests: [:])[0].range)
    }
}
