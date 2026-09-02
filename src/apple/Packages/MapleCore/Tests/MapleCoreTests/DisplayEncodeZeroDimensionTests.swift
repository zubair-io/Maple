// DisplayEncodeZeroDimensionTests.swift — #3239 Copilot review.
//
// `PipelineRenderer.encodeDisplaySRGB` / `encodeDisplay` /
// `applyChainAndEncodeDisplay` / `applyChainAndEncodeDisplayTarget` all size
// their output buffer as `4 * width * height` f32 lanes and then force-unwrap
// `Data.withUnsafe(Mutable)Bytes { $0.baseAddress! }` on both the input and
// output buffers. With `width == 0 || height == 0` the expected byte count is
// 0, an empty `inputBytes` legitimately passes the size check, and
// `Data(count: 0)` has a NIL `baseAddress` — the force unwraps would trap
// instead of throwing. Each function now guards `width > 0, height > 0`
// before ever touching a buffer pointer; these tests lock that in as a
// thrown `PipelineError`, not a crash, on every affected entry point.
//
// Fixture-free — runs everywhere, no `test-fixtures/raws` dependency.

import Foundation
import RawPipeline
import XCTest
@testable import MapleCore

final class DisplayEncodeZeroDimensionTests: XCTestCase {

    private func assertThrowsZeroDimension(
        _ body: () throws -> Void,
        function: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try body(), "\(function) must throw, not trap, on a zero dimension",
            file: file, line: line) { error in
            guard case PipelineError.renderFailed(let code, let message) = error else {
                XCTFail("\(function) threw an unexpected error type: \(error)", file: file, line: line)
                return
            }
            XCTAssertEqual(code, 2, "\(function) zero-dimension error code", file: file, line: line)
            XCTAssertTrue(message.contains("zero dimension"),
                "\(function) message should name the zero dimension, got: \(message)",
                file: file, line: line)
        }
    }

    func testEncodeDisplaySRGBZeroWidthThrowsInsteadOfTrapping() {
        assertThrowsZeroDimension({
            _ = try PipelineRenderer.encodeDisplaySRGB(inputBytes: Data(), width: 0, height: 4)
        }, function: "encodeDisplaySRGB(width: 0)")
    }

    func testEncodeDisplaySRGBZeroHeightThrowsInsteadOfTrapping() {
        assertThrowsZeroDimension({
            _ = try PipelineRenderer.encodeDisplaySRGB(inputBytes: Data(), width: 4, height: 0)
        }, function: "encodeDisplaySRGB(height: 0)")
    }

    func testEncodeDisplayZeroDimensionThrowsInsteadOfTrapping() {
        assertThrowsZeroDimension({
            _ = try PipelineRenderer.encodeDisplay(
                inputBytes: Data(), width: 0, height: 0,
                targetPrimaries: CanvasColorSpace.srgb.wireValue
            )
        }, function: "encodeDisplay(0x0)")
    }

    func testApplyChainAndEncodeDisplayZeroDimensionThrowsInsteadOfTrapping() {
        assertThrowsZeroDimension({
            _ = try PipelineRenderer.applyChainAndEncodeDisplay(
                inputBytes: Data(), width: 0, height: 0,
                params: MapleAdjustmentParams()
            )
        }, function: "applyChainAndEncodeDisplay(0x0)")
    }

    func testApplyChainAndEncodeDisplayTargetZeroDimensionThrowsInsteadOfTrapping() {
        assertThrowsZeroDimension({
            _ = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
                inputBytes: Data(), width: 0, height: 0,
                params: MapleAdjustmentParams(),
                targetPrimaries: CanvasColorSpace.displayP3.wireValue
            )
        }, function: "applyChainAndEncodeDisplayTarget(0x0)")
    }

    /// Companion guard on `encodeDisplay` / `applyChainAndEncodeDisplayTarget`:
    /// an out-of-range `targetPrimaries` must also throw here rather than
    /// silently coercing to sRGB on the Rust side (Copilot review on #3239).
    func testEncodeDisplayUnsupportedTargetPrimariesThrows() {
        XCTAssertThrowsError(try PipelineRenderer.encodeDisplay(
            inputBytes: Data(count: 16), width: 1, height: 1, targetPrimaries: 99
        )) { error in
            guard case PipelineError.renderFailed(let code, let message) = error else {
                return XCTFail("unexpected error type: \(error)")
            }
            XCTAssertEqual(code, 2)
            XCTAssertTrue(message.contains("unsupported targetPrimaries"))
        }
    }
}
