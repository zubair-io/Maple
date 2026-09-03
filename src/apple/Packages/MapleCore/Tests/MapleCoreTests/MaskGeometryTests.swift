// MaskGeometryTests.swift — overlay handle math (#355).

import XCTest

@testable import MapleCore

final class MaskGeometryTests: XCTestCase {
    private let footprint = CropGeometry.Footprint(left: 100, top: 50, width: 600, height: 400)
    private let native = CGSize(width: 6000, height: 4000)

    private var map: MaskCanvasMap {
        MaskCanvasMap(footprint: footprint, crop: .identity, nativeSize: native)
    }

    func testScreenMappingRoundTripsAtFit() {
        let p = MaskPoint(x: 0.25, y: 0.75)
        let px = map.toScreen(p)
        XCTAssertEqual(px.x, 250)
        XCTAssertEqual(px.y, 350)
        let back = map.fromScreen(px)
        XCTAssertEqual(back.x, 0.25, accuracy: 1e-12)
        XCTAssertEqual(back.y, 0.75, accuracy: 1e-12)
    }

    func testFromScreenClampsToTheFrame() {
        let outside = map.fromScreen(CGPoint(x: -500, y: 9000))
        XCTAssertEqual(outside.x, 0)
        XCTAssertEqual(outside.y, 1)
    }

    func testCroppedMapPlacesAFullFramePointRelativeToTheCrop() {
        let cropped = MaskCanvasMap(
            footprint: footprint,
            crop: Crop(top: 0.25, left: 0.5, bottom: 0.75, right: 1, angle: 0),
            nativeSize: native)
        // The full-frame point (0.5, 0.25) is the crop's top-left corner.
        let px = cropped.toScreen(MaskPoint(x: 0.5, y: 0.25))
        XCTAssertEqual(px.x, 100, accuracy: 1e-9)
        XCTAssertEqual(px.y, 50, accuracy: 1e-9)
        let back = cropped.fromScreen(CGPoint(x: 700, y: 450))
        XCTAssertEqual(back.x, 1, accuracy: 1e-9)
        XCTAssertEqual(back.y, 0.75, accuracy: 1e-9)
    }

    func testLinearHandlesAreTheEndpointsAndMidpoint() {
        let mask = LocalMask.linear(start: MaskPoint(x: 0.2, y: 0.2), end: MaskPoint(x: 0.6, y: 0.8), feather: 0.5)
        let handles = MaskGeometry.handles(for: mask)
        XCTAssertEqual(handles.map(\.handle), [.linearStart, .linearEnd, .linearBody])
        XCTAssertEqual(handles[2].point, MaskPoint(x: 0.4, y: 0.5))
    }

    func testRadialHandlesFollowTheRotation() {
        let mask = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.2, y: 0.1),
            angle: .pi / 2, feather: 0.5, invert: false)
        let handles = Dictionary(uniqueKeysWithValues: MaskGeometry.handles(for: mask).map { ($0.handle, $0.point) })
        XCTAssertEqual(handles[.radialRadiusX]!.x, 0.5, accuracy: 1e-12)
        XCTAssertEqual(handles[.radialRadiusX]!.y, 0.7, accuracy: 1e-12)
        XCTAssertEqual(handles[.radialRadiusY]!.x, 0.4, accuracy: 1e-12)
        XCTAssertEqual(handles[.radialRadiusY]!.y, 0.5, accuracy: 1e-12)
        XCTAssertEqual(handles[.radialRotate]!.y, 0.5 + 0.2 * MaskGeometry.rotateHandleFactor, accuracy: 1e-12)
    }

    func testHitTestPrefersEndpointsOverTheBody() {
        let mask = LocalMask.linear(start: MaskPoint(x: 0.5, y: 0.5), end: MaskPoint(x: 0.52, y: 0.5), feather: 0.5)
        let hit = MaskGeometry.hitTest(map.toScreen(MaskPoint(x: 0.5, y: 0.5)), mask: mask, map: map, tolerance: 14)
        XCTAssertEqual(hit, .linearStart)
        XCTAssertNil(MaskGeometry.hitTest(CGPoint(x: 0, y: 0), mask: mask, map: map, tolerance: 14))
    }

    func testDraggingTheBodyTranslatesBothEndpoints() {
        let mask = LocalMask.linear(start: MaskPoint(x: 0.2, y: 0.2), end: MaskPoint(x: 0.6, y: 0.2), feather: 0.5)
        let moved = MaskGeometry.dragged(
            mask, handle: .linearBody, to: MaskPoint(x: 0.5, y: 0.4), from: MaskPoint(x: 0.4, y: 0.2))
        guard case .linear(let start, let end, let feather) = moved else { return XCTFail("shape changed") }
        XCTAssertEqual(start, MaskPoint(x: 0.3, y: 0.4))
        XCTAssertEqual(end, MaskPoint(x: 0.7, y: 0.4))
        XCTAssertEqual(feather, 0.5)
    }

    func testDraggingARadiusHandleProjectsOntoTheLocalAxisWithAFloor() {
        let mask = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.2, y: 0.1),
            angle: 0, feather: 0.5, invert: false)
        let wider = MaskGeometry.dragged(mask, handle: .radialRadiusX, to: MaskPoint(x: 0.9, y: 0.7), from: .init(x: 0.7, y: 0.5))
        guard case .radial(_, let radii, _, _, _) = wider else { return XCTFail("shape changed") }
        XCTAssertEqual(radii.x, 0.4, accuracy: 1e-12)
        XCTAssertEqual(radii.y, 0.1)
        let collapsed = MaskGeometry.dragged(mask, handle: .radialRadiusY, to: MaskPoint(x: 0.5, y: 0.5), from: .init(x: 0.5, y: 0.6))
        guard case .radial(_, let radii2, _, _, _) = collapsed else { return XCTFail("shape changed") }
        XCTAssertEqual(radii2.y, MaskGeometry.minimumRadius)
    }

    func testDraggingTheRotationPinSetsTheAngle() {
        let mask = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.2, y: 0.1),
            angle: 0, feather: 0.5, invert: true)
        let rotated = MaskGeometry.dragged(mask, handle: .radialRotate, to: MaskPoint(x: 0.5, y: 0.9), from: .init(x: 0.76, y: 0.5))
        guard case .radial(_, _, let angle, _, let invert) = rotated else { return XCTFail("shape changed") }
        XCTAssertEqual(angle, .pi / 2, accuracy: 1e-12)
        XCTAssertTrue(invert)
    }

    func testDefaultRadialIsACircleOnScreen() {
        guard case .radial(_, let radii, _, _, _) = MaskGeometry.defaultRadial(imageAspect: 1.5) else {
            return XCTFail("expected radial")
        }
        XCTAssertEqual(radii.y / radii.x, 1.5, accuracy: 1e-12)
    }

    func testEllipseOutlineStaysOnTheEllipse() {
        let center = MaskPoint(x: 0.5, y: 0.5)
        let radii = MaskPoint(x: 0.3, y: 0.1)
        for p in MaskGeometry.ellipseOutline(center: center, radii: radii, angle: 0.4, samples: 24) {
            // Every outline point evaluates to the boundary of a hard-edged mask.
            let inside = MaskWeight.evaluate(
                .radial(center: center, radii: MaskPoint(x: radii.x * 1.01, y: radii.y * 1.01), angle: 0.4, feather: 0, invert: false),
                x: p.x, y: p.y)
            let outside = MaskWeight.evaluate(
                .radial(center: center, radii: MaskPoint(x: radii.x * 0.99, y: radii.y * 0.99), angle: 0.4, feather: 0, invert: false),
                x: p.x, y: p.y)
            XCTAssertEqual(inside, 1)
            XCTAssertEqual(outside, 0)
        }
    }
}
