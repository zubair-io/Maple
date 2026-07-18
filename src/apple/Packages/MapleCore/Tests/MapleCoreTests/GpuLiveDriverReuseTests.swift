// GpuLiveDriverReuseTests.swift — #2039 (session reuse on dims coverage) and
// #2049 (upload identity: decode generation + crop) for `GpuLiveDriver`.
//
// `GpuLiveDriver.shouldReuseSession` is the pure decision factored out of
// `isOpen(coveringWidth:height:identity:)` specifically so this logic is
// testable with no Metal / `CAMetalLayer` / `GpuLiveSession` involved — the
// driver itself can only be exercised on a real device/simulator with a
// live Metal layer, but the reuse DECISION is plain data.

import XCTest
import CoreGraphics
@testable import MapleCore

final class GpuLiveDriverReuseTests: XCTestCase {
    private let identity = GpuUploadIdentity(decodeGeneration: 7, crop: .identity)

    // MARK: - No session open

    func testNoOpenSessionNeverReuses() {
        XCTAssertFalse(
            GpuLiveDriver.shouldReuseSession(
                openDims: nil, uploadedIdentity: nil,
                requestWidth: 100, requestHeight: 100, requestIdentity: identity
            ),
            "no open session can never be reused")
    }

    // MARK: - Dims coverage (#2039)

    /// A session opened at the ≤2× refine size covers a smaller fast-phase
    /// request at the SAME identity — this is the actual perf win: the fast
    /// phase re-presents the already-uploaded bigger buffer (supersampled
    /// down through the layer) instead of reading back + re-uploading.
    func testLargerOpenSessionCoversSmallerRequestSameIdentity() {
        XCTAssertTrue(
            GpuLiveDriver.shouldReuseSession(
                openDims: (width: 2000, height: 1500), uploadedIdentity: identity,
                requestWidth: 1000, requestHeight: 750, requestIdentity: identity
            ),
            "a session covering the request on both axes at the same identity must be reused")
    }

    func testExactlyEqualDimsSameIdentityReuses() {
        XCTAssertTrue(
            GpuLiveDriver.shouldReuseSession(
                openDims: (width: 1000, height: 750), uploadedIdentity: identity,
                requestWidth: 1000, requestHeight: 750, requestIdentity: identity
            ),
            "exact-dims match (today's pre-#2039 case) must still reuse")
    }

    func testSmallerOpenSessionDoesNotCoverLargerRequest() {
        XCTAssertFalse(
            GpuLiveDriver.shouldReuseSession(
                openDims: (width: 800, height: 600), uploadedIdentity: identity,
                requestWidth: 1000, requestHeight: 750, requestIdentity: identity
            ),
            "a session smaller than the request on both axes must force a re-open")
    }

    func testOpenSessionCoveringOnlyOneAxisDoesNotReuse() {
        XCTAssertFalse(
            GpuLiveDriver.shouldReuseSession(
                openDims: (width: 2000, height: 600), uploadedIdentity: identity,
                requestWidth: 1000, requestHeight: 750, requestIdentity: identity
            ),
            "coverage must hold on BOTH axes — a session narrower on height only must re-open")
    }

    // MARK: - Upload identity (#2049)

    /// A same-dims (even covering-dims) session with a DIFFERENT decode
    /// generation must NOT reuse — this is the #2049 fix: a baked-field
    /// edit (highlightRecovery, captureSharpening*, sharpen*) forces a fresh
    /// decode at unchanged dims, and dims-only reuse would silently present
    /// the live chain over the stale uploaded buffer.
    func testDifferentDecodeGenerationForcesReopenDespiteCoveringDims() {
        let staleIdentity = GpuUploadIdentity(decodeGeneration: 6, crop: .identity)
        XCTAssertFalse(
            GpuLiveDriver.shouldReuseSession(
                openDims: (width: 2000, height: 1500), uploadedIdentity: staleIdentity,
                requestWidth: 1000, requestHeight: 750, requestIdentity: identity
            ),
            "a decode-generation mismatch must force a re-open even at covering dims")
    }

    /// A crop CHANGE must force a re-open even when the covering dims are
    /// unchanged — `CropImageStage.apply` can coincidentally produce the
    /// same pixel extent for two different crop rects (#2039).
    func testDifferentCropForcesReopenDespiteCoveringDims() {
        let cropA = Crop.identity
        var cropB = Crop.identity
        cropB.left = 0.1
        cropB.right = 0.9
        let identityA = GpuUploadIdentity(decodeGeneration: 7, crop: cropA)
        let identityB = GpuUploadIdentity(decodeGeneration: 7, crop: cropB)
        XCTAssertFalse(
            GpuLiveDriver.shouldReuseSession(
                openDims: (width: 2000, height: 1500), uploadedIdentity: identityA,
                requestWidth: 1000, requestHeight: 750, requestIdentity: identityB
            ),
            "a crop change must force a re-open even at unchanged/covering dims")
    }

    func testSameGenerationAndCropReusesAtCoveringDims() {
        let a = GpuUploadIdentity(decodeGeneration: 42, crop: .identity)
        let b = GpuUploadIdentity(decodeGeneration: 42, crop: .identity)
        XCTAssertTrue(
            GpuLiveDriver.shouldReuseSession(
                openDims: (width: 2000, height: 1500), uploadedIdentity: a,
                requestWidth: 1000, requestHeight: 750, requestIdentity: b
            ),
            "identical (decodeGeneration, crop) identity must reuse regardless of struct instance")
    }
}

// MARK: - GpuUploadIdentity equality

final class GpuUploadIdentityTests: XCTestCase {
    func testEqualComponentsAreEqual() {
        let a = GpuUploadIdentity(decodeGeneration: 3, crop: .identity)
        let b = GpuUploadIdentity(decodeGeneration: 3, crop: .identity)
        XCTAssertEqual(a, b)
    }

    func testDifferentGenerationIsNotEqual() {
        let a = GpuUploadIdentity(decodeGeneration: 3, crop: .identity)
        let b = GpuUploadIdentity(decodeGeneration: 4, crop: .identity)
        XCTAssertNotEqual(a, b)
    }

    func testDifferentCropIsNotEqual() {
        var crop = Crop.identity
        crop.left = 0.2
        let a = GpuUploadIdentity(decodeGeneration: 3, crop: .identity)
        let b = GpuUploadIdentity(decodeGeneration: 3, crop: crop)
        XCTAssertNotEqual(a, b)
    }
}
