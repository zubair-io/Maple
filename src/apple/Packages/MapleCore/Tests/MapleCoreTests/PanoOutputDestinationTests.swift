// PanoOutputDestinationTests.swift — a panorama never takes the name of a
// file already there or of another stitch in flight, and claiming a name
// writes nothing into the user's folder.

import XCTest
import os
@testable import MapleCore

final class PanoOutputDestinationTests: XCTestCase {
    private var dir: URL!
    private var reserved: [URL] = []
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-output-\(UUID().uuidString)/Panoramas", isDirectory: true)
    }

    override func tearDownWithError() throws {
        reserved.forEach(PanoOutputDestination.release)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
        try? FileManager.default.removeItem(at: dir.deletingLastPathComponent())
    }

    private func reserve() throws -> URL {
        let url = try PanoOutputDestination.reserve(in: dir, now: now)
        reserved.append(url)
        return url
    }

    func testTwoStitchesInTheSameSecondGetDifferentNames() throws {
        let first = try reserve()
        let second = try reserve()

        XCTAssertEqual(first.lastPathComponent, "panorama-1800000000.png")
        XCTAssertEqual(second.lastPathComponent, "panorama-1800000000-2.png")
    }

    func testConcurrentStitchesNeverShareAName() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stitchCount = 64
        let results = OSAllocatedUnfairLock<[URL]>(initialState: [])
        let directory = dir!
        let instant = now
        DispatchQueue.concurrentPerform(iterations: stitchCount) { _ in
            guard let url = try? PanoOutputDestination.reserve(in: directory, now: instant) else { return }
            results.withLock { $0.append(url) }
        }
        let urls = results.withLock { $0 }
        reserved.append(contentsOf: urls)

        XCTAssertEqual(urls.count, stitchCount)
        XCTAssertEqual(Set(urls).count, stitchCount)
    }

    func testAnExistingFileOrUnfinishedPartialKeepsItsName() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let existing = dir.appendingPathComponent("panorama-1800000000.png")
        try Data("earlier panorama".utf8).write(to: existing)
        try Data().write(to: dir.appendingPathComponent("panorama-1800000000-2.png.partial"))

        let claimed = try reserve()

        XCTAssertEqual(claimed.lastPathComponent, "panorama-1800000000-3.png")
        XCTAssertEqual(try Data(contentsOf: existing), Data("earlier panorama".utf8))
    }

    func testClaimingANameWritesNothing() throws {
        let claimed = try reserve()

        XCTAssertFalse(FileManager.default.fileExists(atPath: claimed.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    func testAReleasedNameCanBeClaimedAgain() throws {
        let first = try PanoOutputDestination.reserve(in: dir, now: now)
        PanoOutputDestination.release(first)

        XCTAssertEqual(try reserve(), first)
    }

    func testAnUnwritableDirectoryIsAnError() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)

        XCTAssertThrowsError(try PanoOutputDestination.reserve(in: dir, now: now))
    }
}
