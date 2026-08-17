// SourcesSettingsVMTests.swift
//
// Covers the pure derivations behind the ServerAdmin Sources page (#2898).
// These live in a `+VM` sibling per issue #192 precisely so they're
// reachable from a test — the view itself isn't, because XCUITest is
// unavailable on the primary dev machine (#2525).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class SourcesSettingsVMTests: XCTestCase {

    private func folder(
        id: String = "f1", connected: Bool? = nil, fileCount: Int = 0
    ) -> CloudFolder {
        CloudFolder(
            id: id, path: "/mnt/\(id)", label: id,
            file_count: fileCount, connected: connected)
    }

    // MARK: - disconnectedCount / disconnectedHint

    func test_disconnectedCount_treatsAbsentFlagAsConnected() {
        let folders = [
            folder(id: "a"),                 // pre-upgrade server: no flag
            folder(id: "b", connected: true),
            folder(id: "c", connected: false),
            folder(id: "d", connected: false),
        ]
        XCTAssertEqual(SourcesSettingsVM.disconnectedCount(folders), 2)
    }

    func test_disconnectedHint_nilWhenAllReachable() {
        XCTAssertNil(SourcesSettingsVM.disconnectedHint([folder(id: "a", connected: true)]))
        XCTAssertNil(SourcesSettingsVM.disconnectedHint([]))
    }

    func test_disconnectedHint_pluralizes() {
        let one = SourcesSettingsVM.disconnectedHint([folder(id: "a", connected: false)])
        XCTAssertTrue(one?.hasPrefix("1 source is") == true)
        let two = SourcesSettingsVM.disconnectedHint([
            folder(id: "a", connected: false), folder(id: "b", connected: false),
        ])
        XCTAssertTrue(two?.hasPrefix("2 sources are") == true)
        // The reassurance clause is load-bearing copy — hiding is
        // non-destructive and the hint must say so.
        XCTAssertTrue(two?.contains("Nothing was removed") == true)
    }

    // MARK: - row labels

    func test_statusLabel() {
        XCTAssertEqual(SourcesSettingsVM.statusLabel(isConnected: true), "Connected")
        XCTAssertEqual(SourcesSettingsVM.statusLabel(isConnected: false), "Not connected")
    }

    func test_fileCountLabel() {
        XCTAssertEqual(SourcesSettingsVM.fileCountLabel(folder(id: "a", fileCount: 42)), "42 files")
    }
}
