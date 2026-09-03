// EditTransactionTests — the transaction value type (#2432): the
// deterministic sidecar diff, the invalidation classifier, the no-op rule,
// and the bounded, versioned wire form the web mirror must match.

import XCTest

@testable import MapleCore

final class EditTransactionTests: XCTestCase {
    private func tx(_ before: AdjustmentModel, _ after: AdjustmentModel,
                    kind: EditTransaction.Kind = .adjustment) -> EditTransaction? {
        EditTransaction.make(id: 1, kind: kind, description: "t", before: before, after: after)
    }

    func testNoOpIsNotATransaction() {
        XCTAssertNil(tx(.default, .default))
    }

    func testDiffIsDeterministicSortedAndCanonical() {
        var after = AdjustmentModel.default
        after.exposure = 0.5
        after.contrast = 12
        let a = tx(.default, after)!
        let b = tx(.default, after)!
        XCTAssertEqual(a.diff, b.diff)
        XCTAssertEqual(a.diff.map(\.key), ["crs:Contrast2012", "crs:Exposure2012"])
        XCTAssertEqual(a.diff.map(\.key), a.diff.map(\.key).sorted())
        // Values are the canonical sidecar attribute strings — the same bytes
        // the XMP writer emits, so a web transaction over the same models
        // produces an identical diff (docs/xmp-canonical-format.md).
        // `before` is nil, not "0": the diff is omit-on-default on both
        // platforms even though the Apple writer emits the core block
        // unconditionally (see `SidecarDiff.attributes(of:)`).
        XCTAssertEqual(a.diff[1], SidecarFieldChange(key: "crs:Exposure2012", before: nil, after: "0.5"))
        XCTAssertEqual(a.invalidation, .develop)
    }

    func testOmittedOnDefaultAttributesDiffAsAbsent() {
        // Brightness is omit-on-default: `before` has no attribute at all.
        var after = AdjustmentModel.default
        after.brightness = 10
        let t = tx(.default, after)!
        XCTAssertEqual(t.diff, [SidecarFieldChange(key: "papp:Brightness", before: nil, after: "10")])
    }

    func testToneCurveChangesAreInTheDiff() {
        var after = AdjustmentModel.default
        after.toneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 128, y: 160), (x: 255, y: 255)])
        let t = tx(.default, after)!
        XCTAssertEqual(t.diff.map(\.key), ["toneCurves"])
        XCTAssertNil(t.diff[0].before)
        XCTAssertTrue(t.diff[0].after?.contains("papp:SceneLinearToneCurve") == true)
    }

    func testInvalidationScopeClassification() {
        var cropOnly = AdjustmentModel.default
        cropOnly.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0)
        XCTAssertEqual(InvalidationScope.classify(from: .default, to: cropOnly), .crop)

        var develop = AdjustmentModel.default
        develop.saturation = 30
        XCTAssertEqual(InvalidationScope.classify(from: .default, to: develop), .develop)

        var decode = AdjustmentModel.default
        decode.deepDenoise = 40
        XCTAssertEqual(InvalidationScope.classify(from: .default, to: decode), .decode)

        var cropAndDevelop = cropOnly
        cropAndDevelop.exposure = 1
        XCTAssertEqual(InvalidationScope.classify(from: .default, to: cropAndDevelop), .develop)

        XCTAssertEqual(InvalidationScope.classify(from: .default, to: .default), .none)
        XCTAssertEqual(tx(.default, cropOnly, kind: .crop)?.invalidation, .crop)
        XCTAssertEqual(tx(.default, decode)?.invalidation, .decode)
    }

    /// The wire form is versioned and bounded: no model snapshots, one entry
    /// per changed canonical attribute, canonical key order. The literal
    /// below is pinned on the web side too
    /// (`editor/edit-transaction.spec.ts`) — the two must stay byte-equal.
    func testSerializedFormIsVersionedBoundedAndPlatformIdentical() throws {
        var after = AdjustmentModel.default
        after.exposure = 0.5
        let t = tx(.default, after)!
        XCTAssertEqual(EditTransaction.serializationVersion, 1)
        XCTAssertEqual(
            t.serializedJSON(),
            #"{"description":"t","diff":[{"after":"0.5","before":null,"key":"crs:Exposure2012"}],"id":1,"invalidation":"develop","kind":"adjustment","version":1}"#
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(t.serializedJSON().utf8)) as? [String: Any])
        XCTAssertNil(object["before"])
        XCTAssertNil(object["after"])
        // Bounded: never more entries than there are canonical attributes.
        XCTAssertLessThanOrEqual(t.diff.count, SidecarDiff.attributes(of: after).count + 1)
    }

    func testEveryKindHasAStableWireValue() {
        XCTAssertEqual(
            EditTransaction.Kind.allCases.map(\.rawValue),
            ["adjustment", "auto", "crop", "paste", "preset", "reset", "mask", "repair", "variant"])
    }
}
