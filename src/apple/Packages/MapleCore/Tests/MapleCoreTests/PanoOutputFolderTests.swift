// PanoOutputFolderTests.swift — the free-space preflight measures the folder
// the stitch will actually write its panorama into (#5555): the same
// candidate order and acceptance as the reservation, through symlinks.

import XCTest
@testable import MapleCore

final class PanoOutputFolderTests: XCTestCase {
    private var root: URL!
    private var reserved: [URL] = []
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private var frames: URL { root.appendingPathComponent("frames", isDirectory: true) }
    private var panoramas: URL { frames.appendingPathComponent("Panoramas", isDirectory: true) }
    private var fallback: URL { root.appendingPathComponent("fallback", isDirectory: true) }
    private var candidates: [URL] { [panoramas, fallback] }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-output-folder-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        reserved.forEach(PanoOutputDestination.release)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: panoramas.path)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: frames.path)
        try? FileManager.default.removeItem(at: root)
    }

    private func reservedFolder() throws -> URL {
        let url = try PanoOutputDestination.reserve(among: candidates, now: now)
        reserved.append(url)
        return url.deletingLastPathComponent()
    }

    private func assertPreflightMatchesReservation(_ expected: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        let predicted = try XCTUnwrap(PanoOutputDestination.destination(among: candidates))
        XCTAssertEqual(predicted.standardizedFileURL, expected.standardizedFileURL, file: file, line: line)
        XCTAssertEqual(try reservedFolder().standardizedFileURL, predicted.standardizedFileURL, file: file, line: line)
    }

    func testAMissingPanoramasFolderUnderWritableFramesIsTheDestination() throws {
        try assertPreflightMatchesReservation(panoramas)
    }

    func testAnUnwritablePanoramasFolderFallsBack() throws {
        try FileManager.default.createDirectory(at: panoramas, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: panoramas.path)
        try assertPreflightMatchesReservation(fallback)
    }

    func testUnwritableFramesWithoutAPanoramasFolderFallBack() throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: frames.path)
        try assertPreflightMatchesReservation(fallback)
    }

    func testASymlinkedPanoramasFolderIsTheDestination() throws {
        let elsewhere = root.appendingPathComponent("elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: panoramas, withDestinationURL: elsewhere)
        try assertPreflightMatchesReservation(panoramas)
    }

    func testADanglingSymlinkedPanoramasFolderFallsBack() throws {
        try FileManager.default.createSymbolicLink(
            at: panoramas, withDestinationURL: root.appendingPathComponent("gone", isDirectory: true))
        try assertPreflightMatchesReservation(fallback)
    }

    func testFreeSpaceIsReadOnASymlinkedFoldersTarget() throws {
        let elsewhere = root.appendingPathComponent("elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: panoramas, withDestinationURL: elsewhere)
        var queried: [String] = []

        _ = PanoFreeSpace.current(outputFolder: panoramas) { url in
            queried.append(url.path)
            return PanoFreeSpace.volume(of: url)
        }

        XCTAssertEqual(queried.last, PanoFreeSpace.realPath(elsewhere)?.path)
    }

    func testFreeSpaceForAFolderNotYetCreatedIsReadOnItsParent() throws {
        var queried: [String] = []

        _ = PanoFreeSpace.current(outputFolder: panoramas) { url in
            queried.append(url.path)
            return PanoFreeSpace.volume(of: url)
        }

        XCTAssertEqual(queried.last, PanoFreeSpace.realPath(frames)?.path)
    }

    func testAFileWhereTheFolderShouldBeFallsBack() throws {
        try Data().write(to: panoramas)
        try assertPreflightMatchesReservation(fallback)
    }

    func testMissingFoldersUnderAReadOnlyAncestorFallBack() throws {
        let deep = frames.appendingPathComponent("a/b/Panoramas", isDirectory: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: frames.path)
        XCTAssertFalse(PanoOutputDestination.accepts(deep))
        XCTAssertEqual(PanoOutputDestination.destination(among: [deep, fallback]), fallback)
    }

    func testASymlinkToAReadOnlyFolderFallsBack() throws {
        let readOnly = root.appendingPathComponent("read-only", isDirectory: true)
        try FileManager.default.createDirectory(at: readOnly, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: readOnly.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: readOnly.path) }
        try FileManager.default.createSymbolicLink(at: panoramas, withDestinationURL: readOnly)
        try assertPreflightMatchesReservation(fallback)
    }

    func testFreeSpaceUnderTmpIsReadOnTheRealFolderNotTheLink() throws {
        var queried: [String] = []

        _ = PanoFreeSpace.current(outputFolder: URL(fileURLWithPath: "/tmp/maple-pano-not-there-\(UUID().uuidString)")) { url in
            queried.append(url.path)
            return PanoFreeSpace.volume(of: url)
        }

        XCTAssertEqual(queried.last, "/private/tmp")
    }

    func testTheStitcherTriesBesideTheFramesThenApplicationSupport() {
        let first = frames.appendingPathComponent("IMG_0001.dng")
        XCTAssertEqual(
            RustPanoStitcher().outputDirectoryCandidates(near: first),
            [panoramas, RustPanoStitcher.fallbackOutputDirectory])
        XCTAssertEqual(RustPanoStitcher(outputDirectory: fallback).outputDirectoryCandidates(near: first), [fallback])
    }
}
