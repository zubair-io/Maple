// ToneCurveMathTests.swift — curve evaluation + point-editing rules (#367).
//
// `ToneCurveMath` is a port of raw-core's Fritsch–Carlson evaluator and
// `ToneCurveEditing` enforces the invariants the stage assumes, so both are
// pure value math and test without a UI host.

import XCTest
@testable import MapleCore

final class ToneCurveMathTests: XCTestCase {

    // MARK: - Cross-platform parity anchor

    /// The shared curve-editor parity anchor (#367). Identical knots and
    /// samples are asserted in raw-core's
    /// `monotonic_cubic_matches_the_cross_platform_parity_anchor` and in
    /// `tone-curve.spec.ts`. The three ports must agree, because the
    /// widget's job is to draw the shape the pipeline renders — a plot that
    /// interpolates differently is a lie about the photo.
    private static let parityKnots: [ToneCurvePoint] = [
        (x: 0.0, y: 0.0),
        (x: 0.25, y: 0.15),
        (x: 0.6, y: 0.72),
        (x: 1.0, y: 1.0),
    ]
    private static let paritySamples: [Double] = [
        0.000000, 0.047657, 0.103543, 0.215379, 0.386152, 0.570335,
        0.720000, 0.816116, 0.883214, 0.938705, 1.000000,
    ]

    func testMatchesRawCoreParityAnchor() {
        let curve = ToneCurveMath.prepare(Self.parityKnots)
        for (i, expected) in Self.paritySamples.enumerated() {
            let x = Double(i) / 10.0
            XCTAssertEqual(
                ToneCurveMath.evaluate(curve, at: x), expected, accuracy: 1e-5,
                "x=\(x)"
            )
        }
    }

    // MARK: - Evaluator edge cases

    func testEmptyCurveIsIdentity() {
        let curve = ToneCurveMath.prepare([])
        XCTAssertEqual(ToneCurveMath.evaluate(curve, at: 0.37), 0.37, accuracy: 1e-9)
    }

    func testSingleKnotIsConstantLikeTheStage() {
        let curve = ToneCurveMath.prepare([(x: 0.5, y: 0.7)])
        XCTAssertEqual(ToneCurveMath.evaluate(curve, at: 0.1), 0.7, accuracy: 1e-9)
        XCTAssertEqual(ToneCurveMath.evaluate(curve, at: 0.9), 0.7, accuracy: 1e-9)
    }

    func testStaysMonotonicThroughASteepKnot() {
        let curve = ToneCurveMath.prepare([
            (x: 0.0, y: 0.0), (x: 0.45, y: 0.05), (x: 0.55, y: 0.95), (x: 1.0, y: 1.0),
        ])
        let samples = (0...100).map { ToneCurveMath.evaluate(curve, at: Double($0) / 100) }
        for (i, y) in samples.enumerated() {
            if i > 0 { XCTAssertGreaterThanOrEqual(y, samples[i - 1] - 1e-9) }
            XCTAssertGreaterThanOrEqual(y, 0)
            XCTAssertLessThanOrEqual(y, 1)
        }
    }

    func testSortsInputAndKeepsTheLaterOfTwoEqualXKnots() {
        let curve = ToneCurveMath.prepare([
            (x: 1.0, y: 1.0), (x: 0.5, y: 0.2), (x: 0.5, y: 0.8), (x: 0.0, y: 0.0),
        ])
        XCTAssertEqual(curve.knots.map(\.x), [0.0, 0.5, 1.0])
        XCTAssertEqual(ToneCurveMath.evaluate(curve, at: 0.5), 0.8, accuracy: 1e-9)
    }

    func testSampleReturnsTheRequestedCountInAuthoringOrientation() {
        let samples = ToneCurveMath.sample([], samples: 4)
        XCTAssertEqual(samples.count, 5)
        // Identity, un-flipped: y rises with x.
        XCTAssertEqual(samples.first?.y ?? -1, 0, accuracy: 1e-9)
        XCTAssertEqual(samples.last?.y ?? -1, 1, accuracy: 1e-9)
    }

    // MARK: - materialize

    func testMaterializeTurnsIdentityIntoTheCornerAnchors() {
        let out = ToneCurveEditing.materialize([])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].x, 0)
        XCTAssertEqual(out[0].y, 0)
        XCTAssertEqual(out[1].x, 1)
        XCTAssertEqual(out[1].y, 1)
    }

    func testMaterializeSorts() {
        let out = ToneCurveEditing.materialize([(x: 0.8, y: 0.9), (x: 0.2, y: 0.1)])
        XCTAssertEqual(out.map(\.x), [0.2, 0.8])
    }

    // MARK: - insert

    func testInsertAddsBetweenTheAnchorsOfAnIdentityCurve() {
        let out = ToneCurveEditing.insert([], x: 0.5, y: 0.7)
        XCTAssertEqual(out.map(\.x), [0.0, 0.5, 1.0])
        XCTAssertEqual(out[1].y, 0.7, accuracy: 1e-9)
    }

    func testInsertNeverProducesALoneKnot() {
        // A single-knot curve is a CONSTANT in the stage — it would flatten
        // the image to one tone. The first click must not create that.
        let out = ToneCurveEditing.insert([], x: 0.3, y: 0.4)
        XCTAssertGreaterThan(out.count, 1)
        XCTAssertEqual(out.first?.x ?? -1, 0)
        XCTAssertEqual(out.last?.x ?? -1, 1)
    }

    func testInsertRefusesAnXCollision() {
        let start = ToneCurveEditing.insert([], x: 0.5, y: 0.7)
        let again = ToneCurveEditing.insert(
            start, x: 0.5 + ToneCurveEditing.minXGap / 2, y: 0.2
        )
        XCTAssertEqual(again.count, start.count)
    }

    func testInsertClampsIntoTheAuthoringDomain() {
        XCTAssertEqual(ToneCurveEditing.insert([], x: 0.5, y: 1.8)[1].y, 1, accuracy: 1e-9)
        XCTAssertEqual(ToneCurveEditing.insert([], x: 0.5, y: -0.4)[1].y, 0, accuracy: 1e-9)
    }

    // MARK: - move

    func testMoveShiftsAnInteriorKnotFreely() {
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        let moved = ToneCurveEditing.move(three, index: 1, x: 0.7, y: 0.3)
        XCTAssertEqual(moved[1].x, 0.7, accuracy: 1e-9)
        XCTAssertEqual(moved[1].y, 0.3, accuracy: 1e-9)
    }

    func testMovePinsEndpointsInXButNotInY() {
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        let first = ToneCurveEditing.move(three, index: 0, x: 0.4, y: 0.25)
        XCTAssertEqual(first[0].x, 0)
        XCTAssertEqual(first[0].y, 0.25, accuracy: 1e-9)
        let last = ToneCurveEditing.move(three, index: 2, x: 0.4, y: 0.8)
        XCTAssertEqual(last[2].x, 1)
        XCTAssertEqual(last[2].y, 0.8, accuracy: 1e-9)
    }

    func testMoveHoldsAnInteriorKnotOffItsNeighbours() {
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        let left = ToneCurveEditing.move(three, index: 1, x: -5, y: 0.5)
        XCTAssertEqual(left[1].x, ToneCurveEditing.minXGap, accuracy: 1e-9)
        let right = ToneCurveEditing.move(three, index: 1, x: 5, y: 0.5)
        XCTAssertEqual(right[1].x, 1 - ToneCurveEditing.minXGap, accuracy: 1e-9)
    }

    func testMoveIgnoresAnOutOfRangeIndex() {
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        XCTAssertEqual(ToneCurveEditing.move(three, index: 9, x: 0.5, y: 0.5).count, 3)
    }

    // MARK: - remove

    func testRemoveDropsAnInteriorKnot() {
        let four = ToneCurveEditing.insert(
            ToneCurveEditing.insert([], x: 0.3, y: 0.2), x: 0.7, y: 0.8
        )
        XCTAssertEqual(ToneCurveEditing.remove(four, index: 1).map(\.x), [0.0, 0.7, 1.0])
    }

    func testRemoveWillNotDeleteAnEndpoint() {
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        XCTAssertEqual(ToneCurveEditing.remove(three, index: 0).count, 3)
        XCTAssertEqual(ToneCurveEditing.remove(three, index: 2).count, 3)
    }

    func testRemoveCollapsesToTheEmptyIdentitySoTheSidecarStaysClean() {
        // The empty list is the identity on all three platforms, and it is
        // what keeps an unedited sidecar free of a curve block (#365).
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        XCTAssertTrue(ToneCurveEditing.remove(three, index: 1).isEmpty)
    }

    func testRemoveKeepsAMovedEndpointRatherThanCollapsing() {
        let lifted = ToneCurveEditing.move(
            ToneCurveEditing.insert([], x: 0.5, y: 0.5), index: 2, x: 1, y: 0.8
        )
        let out = ToneCurveEditing.remove(lifted, index: 1)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[1].y, 0.8, accuracy: 1e-9)
    }

    // MARK: - hitTest

    func testHitTestFindsTheKnotUnderTheCursor() {
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        XCTAssertEqual(ToneCurveEditing.hitTest(three, x: 0.51, y: 0.49, radius: 0.05), 1)
    }

    func testHitTestReturnsNilOnEmptyPlot() {
        let three = ToneCurveEditing.insert([], x: 0.5, y: 0.5)
        XCTAssertNil(ToneCurveEditing.hitTest(three, x: 0.2, y: 0.9, radius: 0.05))
    }

    func testHitTestGrabsTheMaterialisedAnchorsOfAnIdentityCurve() {
        XCTAssertEqual(ToneCurveEditing.hitTest([], x: 0.01, y: 0.01, radius: 0.05), 0)
        XCTAssertEqual(ToneCurveEditing.hitTest([], x: 0.99, y: 0.99, radius: 0.05), 1)
    }

    // MARK: - Tool wiring

    func testToneCurveToolDeclaresTheFourParametricRegions() {
        let subs = Tool.toneCurve.subParams
        XCTAssertEqual(subs.map(\.id), ["highlights", "lights", "darks", "shadows"])
        for sub in subs {
            XCTAssertEqual(sub.range, -100...100)
            XCTAssertEqual(sub.defaultDisplayValue, 0)
        }
    }

    func testToneCurveToolIsWiredIntoLightWithNoPrimaryField() {
        XCTAssertTrue(Tool.toneCurve.isWired)
        XCTAssertEqual(Tool.toneCurve.group, .light)
        // No single primary field — the section is the whole surface, the
        // same shape HSL has.
        XCTAssertNil(ToolValueMapping.displayRange(for: .toneCurve))
    }

    // MARK: - Editor → sidecar round trip

    /// The acceptance criterion for #367: a curve authored the way the
    /// widget authors one — through `ToneCurveEditing`, not a hand-written
    /// point list — survives a real sidecar write and read.
    ///
    /// #365 already pins the XMP encoding itself. What this adds is the
    /// join: that the editing helpers produce a list the sidecar layer
    /// accepts, and that the identity collapse really does leave the file
    /// free of a curve block rather than writing a flat one.
    func testCurveAuthoredThroughTheEditingHelpersRoundTripsOnDisk() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let sidecar = tmp.deletingPathExtension().appendingPathExtension("xmp")
        defer { try? FileManager.default.removeItem(at: sidecar) }

        // Author exactly as the plot does: click to insert, drag to move.
        let inserted = ToneCurveEditing.insert([], x: 0.25, y: 0.15)
        let authored = ToneCurveEditing.move(inserted, index: 1, x: 0.6, y: 0.72)

        var model = AdjustmentModel.default
        model.toneCurveLuma = ToneCurve(points: authored)
        model.toneCurveGreen = ToneCurve(
            points: ToneCurveEditing.insert([], x: 0.5, y: 0.35)
        )
        model.parametricLights = 24

        let store = XMPSidecarStore(rawURL: tmp)
        await store.update(model: model, culling: CullingState())
        await store.flush()

        let fresh = XMPSidecarStore(rawURL: tmp)
        let (loaded, _) = try await fresh.load()

        XCTAssertEqual(loaded.toneCurveLuma.points.count, 3)
        XCTAssertEqual(loaded.toneCurveLuma.points[1].x, 0.6, accuracy: 1.0 / 255.0)
        XCTAssertEqual(loaded.toneCurveLuma.points[1].y, 0.72, accuracy: 1.0 / 255.0)
        XCTAssertEqual(loaded.toneCurveGreen.points.count, 3)
        XCTAssertEqual(loaded.parametricLights, 24, accuracy: 1e-9)
        // Untouched channels stay identity — and the file must not carry a
        // block for them.
        XCTAssertTrue(loaded.toneCurveRed.isIdentity)
        XCTAssertTrue(loaded.toneCurveBlue.isIdentity)
        let text = try String(contentsOf: sidecar, encoding: .utf8)
        XCTAssertTrue(text.contains("papp:SceneLinearToneCurve>"))
        XCTAssertFalse(text.contains("papp:SceneLinearToneCurveRed"))
        XCTAssertFalse(text.contains("papp:SceneLinearToneCurveBlue"))
    }

    /// Resetting a channel must leave the sidecar as clean as it found it —
    /// the identity is the EMPTY list, so no block may survive the reset.
    func testResettingAChannelRemovesItsBlockFromTheSidecar() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let sidecar = tmp.deletingPathExtension().appendingPathExtension("xmp")
        defer { try? FileManager.default.removeItem(at: sidecar) }

        var model = AdjustmentModel.default
        model.toneCurveLuma = ToneCurve(points: ToneCurveEditing.insert([], x: 0.4, y: 0.6))

        let store = XMPSidecarStore(rawURL: tmp)
        await store.update(model: model, culling: CullingState())
        await store.flush()
        XCTAssertTrue(
            try String(contentsOf: sidecar, encoding: .utf8)
                .contains("papp:SceneLinearToneCurve")
        )

        // Reset, exactly as `ToneCurveSection.resetChannel` does.
        model.toneCurveLuma = ToneCurve(points: [])
        await store.update(model: model, culling: CullingState())
        await store.flush()

        let text = try String(contentsOf: sidecar, encoding: .utf8)
        XCTAssertFalse(text.contains("papp:SceneLinearToneCurve"))
        let fresh = XMPSidecarStore(rawURL: tmp)
        let (loaded, _) = try await fresh.load()
        XCTAssertTrue(loaded.toneCurveLuma.isIdentity)
    }

    /// The decode must not bake a curve the live wgpu chain also applies.
    func testStripAppleGPUStagesClearsThePointCurves() {
        var model = AdjustmentModel()
        model.toneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 0.5, y: 0.8), (x: 1, y: 1)])
        model.toneCurveRed = ToneCurve(points: [(x: 0, y: 0), (x: 1, y: 0.9)])
        model.parametricLights = 30

        let stripped = RawCoreBridge.stripAppleGPUStages(model)
        XCTAssertTrue(stripped.toneCurveLuma.isIdentity)
        XCTAssertTrue(stripped.toneCurveRed.isIdentity)
        XCTAssertTrue(stripped.toneCurveGreen.isIdentity)
        XCTAssertTrue(stripped.toneCurveBlue.isIdentity)
        XCTAssertEqual(stripped.parametricLights, 0)
    }
}
