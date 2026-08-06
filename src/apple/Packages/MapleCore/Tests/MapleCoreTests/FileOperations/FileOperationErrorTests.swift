// FileOperationErrorTests.swift — issue #2631's "typed unsupported error"
// acceptance criterion: PhotoKit (and Cloud) callers get an explainable,
// distinctly-cased error rather than a generic failure.

import XCTest
@testable import MapleCore

final class FileOperationErrorTests: XCTestCase {

    func testPhotoKitUnsupportedIsAnUnsupportedSourceCaseWithAnExplanation() {
        let error = FileOperationError.photoKitUnsupported(operation: "move")
        guard case .unsupportedSource(let message) = error else {
            return XCTFail("expected .unsupportedSource, got \(error)")
        }
        XCTAssertTrue(message.contains("PhotoKit"))
        XCTAssertTrue(message.contains("move"))
        XCTAssertNotNil(error.errorDescription)
    }

    func testCloudRoutesThroughAPIIsAnUnsupportedSourceCaseWithAnExplanation() {
        let error = FileOperationError.cloudRoutesThroughAPI(operation: "trash")
        guard case .unsupportedSource(let message) = error else {
            return XCTFail("expected .unsupportedSource, got \(error)")
        }
        XCTAssertTrue(message.contains("Cloud"))
        XCTAssertTrue(message.contains("API"))
    }

    func testEveryCaseHasANonNilLocalizedDescription() {
        let cases: [FileOperationError] = [
            .unsupportedSource("x"), .sourceMissing("x"), .verificationFailed("x"),
            .destinationExists("x"), .invalidDestination("x"), .underlying("x"),
        ]
        for c in cases {
            XCTAssertNotNil(c.errorDescription, "\(c) must explain itself")
        }
    }
}
