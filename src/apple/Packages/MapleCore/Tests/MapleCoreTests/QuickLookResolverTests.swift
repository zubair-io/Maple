// src/apple/Packages/MapleCore/Tests/MapleCoreTests/QuickLookResolverTests.swift
import XCTest
@testable import MapleCore

final class QuickLookResolverTests: XCTestCase {
    func testReturnsMatchingComponent() {
        let url = URL(filePath: "/Users/x/Library/.../FileProvider/aperture/MyDomain/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url,
                                                  configured: ["MyDomain", "Other"])
        XCTAssertEqual(hit, "MyDomain")
    }

    func testReturnsNilWhenNoMatchAndMultipleConfigured() {
        let url = URL(filePath: "/Users/x/tmp/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url,
                                                  configured: ["A", "B"])
        XCTAssertNil(hit)
    }

    func testFallsBackToSoleConfiguredDomain() {
        let url = URL(filePath: "/Users/x/tmp/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url, configured: ["Only"])
        XCTAssertEqual(hit, "Only")
    }

    func testReturnsNilWhenNoneConfigured() {
        let url = URL(filePath: "/Users/x/tmp/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url, configured: [])
        XCTAssertNil(hit)
    }

    // MARK: - isSidecarBasename

    func testIsSidecarBasenameDetectsLowercase() {
        XCTAssertTrue(QuickLookResolver.isSidecarBasename("ABC123.xmp"))
    }

    func testIsSidecarBasenameDetectsUppercase() {
        XCTAssertTrue(QuickLookResolver.isSidecarBasename("ABC123.XMP"))
    }

    func testIsSidecarBasenameDetectsMixedCase() {
        XCTAssertTrue(QuickLookResolver.isSidecarBasename("ABC123.Xmp"))
    }

    /// RAW basenames materialized by the File Provider are extensionless
    /// (`UUID().uuidString`) — they must NOT trip the sidecar guard,
    /// otherwise QuickLook would fall back to system preview and serve
    /// no JPEG.
    func testIsSidecarBasenameRejectsExtensionlessRAW() {
        XCTAssertFalse(QuickLookResolver.isSidecarBasename("ABC123"))
        XCTAssertFalse(QuickLookResolver.isSidecarBasename(UUID().uuidString))
    }

    func testIsSidecarBasenameRejectsXmpInTheMiddle() {
        XCTAssertFalse(QuickLookResolver.isSidecarBasename("xmp-archive.zip"))
    }
}
