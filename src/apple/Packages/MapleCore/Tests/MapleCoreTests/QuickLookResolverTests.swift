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
}
