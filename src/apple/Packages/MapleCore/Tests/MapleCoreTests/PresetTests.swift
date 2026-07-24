// PresetTests.swift — preset model, capture/apply bridge, and built-ins
// (#1115, spec §10.7).
//
// Covers:
//   • PresetFieldValue / Preset Codable round-trips, including the
//     passthrough rule: unknown `fields` keys AND unknown top-level keys
//     survive decode → encode → decode.
//   • PresetAdjustments.captureFields — sparse, non-defaults only.
//   • PresetAdjustments.merged — clamp / skip-unknown / enum guard, and
//     the capture→apply round-trip.
//   • Bundled built-ins: the canonical JSON resource loads, parses, and
//     every field is a known, in-range schema field (the Apple side of
//     the cross-platform parity contract — the web mirror is pinned by
//     the API's builtin-presets-parity test).

import XCTest
@testable import MapleCore

final class PresetTests: XCTestCase {
    // MARK: - Codable

    func testFieldValueScalarRoundTrips() throws {
        let fields: [String: PresetFieldValue] = [
            "contrast": .number(-50),
            "profile": .string("Neutral"),
            "future_flag": .bool(true),
        ]
        let data = try JSONEncoder().encode(fields)
        let back = try JSONDecoder().decode([String: PresetFieldValue].self, from: data)
        XCTAssertEqual(back, fields)
    }

    func testFieldValueRejectsNonScalars() {
        let json = Data(#"{"fields": {"future_blob": {"nested": 1}}}"#.utf8)
        struct Wrapper: Decodable { let fields: [String: PresetFieldValue] }
        XCTAssertThrowsError(try JSONDecoder().decode(Wrapper.self, from: json))
    }

    func testPresetRoundTripPreservesUnknownKeys() throws {
        // A document from a NEWER schema version: unknown field keys and
        // an unknown top-level key. Both must survive a full round-trip.
        let json = Data("""
        {
          "id": "abc123",
          "schemaVersion": 3,
          "name": "From The Future",
          "fields": { "contrast": 10, "future_curve_strength": 0.5, "future_mode": "Soft" },
          "futureTopLevel": { "anything": ["goes", 1, null] }
        }
        """.utf8)

        let preset = try JSONDecoder().decode(Preset.self, from: json)
        XCTAssertEqual(preset.id, "abc123")
        XCTAssertEqual(preset.schemaVersion, 3)
        XCTAssertEqual(preset.fields["future_curve_strength"], .number(0.5))
        XCTAssertEqual(preset.fields["future_mode"], .string("Soft"))
        XCTAssertEqual(
            preset.extra["futureTopLevel"],
            .object(["anything": .array([.string("goes"), .number(1), .null])])
        )
        XCTAssertFalse(preset.builtIn)

        // Re-encode and re-decode: byte order may differ, content may not.
        let reencoded = try JSONEncoder().encode(preset)
        let back = try JSONDecoder().decode(Preset.self, from: reencoded)
        XCTAssertEqual(back, preset)
    }

    func testNormalizeName() {
        XCTAssertEqual(Preset.normalizeName("  Soft Morning  "), "Soft Morning")
        XCTAssertNil(Preset.normalizeName("   "))
        XCTAssertNil(Preset.normalizeName("bad\nname"))
        XCTAssertNil(Preset.normalizeName(String(repeating: "x", count: 121)))
        XCTAssertEqual(
            Preset.normalizeName(String(repeating: "x", count: 120)),
            String(repeating: "x", count: 120)
        )
    }

    // MARK: - Capture

    func testCaptureFieldsFromDefaultModelIsEmpty() {
        XCTAssertTrue(PresetAdjustments.captureFields(from: .default).isEmpty)
    }

    func testCaptureFieldsIsSparseAndSnakeCased() {
        var model = AdjustmentModel.default
        model.exposure = 1.25
        model.nrLuminance = 40
        model.highlightRecovery = .blend
        XCTAssertEqual(PresetAdjustments.captureFields(from: model), [
            "exposure": .number(1.25),
            "nr_luminance": .number(40),
            "highlight_recovery": .string("Blend"),
        ])
    }

    func testCaptureApplyRoundTripsOntoDefaultModel() {
        var edited = AdjustmentModel.default
        edited.contrast = -50
        edited.temperature = 7200
        edited.profile = .neutral

        let fields = PresetAdjustments.captureFields(from: edited)
        let (merged, applied) = PresetAdjustments.merged(.default, applying: fields)
        XCTAssertEqual(applied, 3)
        XCTAssertEqual(merged, edited)
    }

    // MARK: - Apply

    func testMergedClampsNumericValuesToCanonicalRange() {
        let (merged, applied) = PresetAdjustments.merged(.default, applying: [
            "exposure": .number(99),
            "temperature": .number(0),
        ])
        XCTAssertEqual(applied, 2)
        XCTAssertEqual(merged.exposure, 4.0, accuracy: 1e-9)
        XCTAssertEqual(merged.temperature, 2000, accuracy: 1e-9)
    }

    func testMergedSkipsUnknownNonFiniteAndWrongTyped() {
        let (merged, applied) = PresetAdjustments.merged(.default, applying: [
            "future_field": .number(1),          // unknown → skipped
            "contrast": .number(.nan),           // non-finite → skipped
            "exposure": .string("bright"),       // wrong type → skipped
            "saturation": .number(-30),          // valid → applied
        ])
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(merged.saturation, -30, accuracy: 1e-9)
        XCTAssertEqual(merged.contrast, 0, accuracy: 1e-9)
        XCTAssertEqual(merged.exposure, 0, accuracy: 1e-9)
    }

    func testMergedSkipsFieldsTheSwiftModelDoesNotCarry() {
        // wb_method / tone_curve_mode exist in the web schema (and
        // FieldName) but not on the Swift struct yet — a web-written
        // preset carrying them must apply its other fields and skip these
        // (they stay preserved in the stored document). `auto_exposure`
        // (#1387) IS now a Swift field — see
        // `testMergedAppliesAutoExposure` below.
        let (merged, applied) = PresetAdjustments.merged(.default, applying: [
            "wb_method": .string("Cat16"),
            "tone_curve_mode": .string("RatioPreserving"),
            "capture_sharpening_radius": .number(1.5), // deprecated alias
            "contrast": .number(10),
        ])
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(merged.contrast, 10, accuracy: 1e-9)
    }

    func testMergedAppliesAutoExposure() {
        // #1387 — auto_exposure is a real Swift enum field now, applied
        // like highlightRecovery/profile, not skipped as an unknown key.
        let (merged, applied) = PresetAdjustments.merged(.default, applying: [
            "auto_exposure": .string("Off"),
        ])
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(merged.autoExposure, .off)
    }

    func testCaptureFieldsCapturesNonDefaultAutoExposure() {
        var edited = AdjustmentModel.default
        edited.autoExposure = .off
        let fields = PresetAdjustments.captureFields(from: edited)
        XCTAssertEqual(fields["auto_exposure"], .string("Off"))

        let (merged, applied) = PresetAdjustments.merged(.default, applying: fields)
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(merged.autoExposure, .off)
    }

    // MARK: - Built-ins (canonical JSON resource)

    func testBuiltinsLoadFromBundleAndValidate() {
        let builtins = PresetStore.builtins
        XCTAssertEqual(builtins.count, 5)
        XCTAssertTrue(builtins.allSatisfy { $0.builtIn })
        XCTAssertTrue(builtins.allSatisfy { $0.id.hasPrefix("builtin-") })

        // Ids and names unique (case-insensitive names — the save path
        // refuses collisions against them).
        XCTAssertEqual(Set(builtins.map(\.id)).count, builtins.count)
        XCTAssertEqual(Set(builtins.map { $0.name.lowercased() }).count, builtins.count)

        // Every built-in field must be a KNOWN schema field with an
        // in-range value — a bundled preset the client itself would skip
        // is a packaging bug.
        for preset in builtins {
            XCTAssertFalse(preset.fields.isEmpty, "\(preset.name) has no fields")
            for (key, value) in preset.fields {
                guard let field = AdjustmentModel.FieldName(rawValue: key) else {
                    XCTFail("\(preset.name): unknown field \(key)")
                    continue
                }
                if let range = field.numericRange {
                    guard let number = value.numberValue else {
                        XCTFail("\(preset.name): \(key) must be numeric")
                        continue
                    }
                    XCTAssertTrue(
                        range.contains(number),
                        "\(preset.name): \(key)=\(number) outside \(range)"
                    )
                }
            }
            // The whole preset must be applicable on this client.
            let (_, applied) = PresetAdjustments.merged(.default, applying: preset.fields)
            XCTAssertEqual(applied, preset.fields.count, "\(preset.name) not fully applicable")
        }
    }
}
