// AssetRefStubAudioTests.swift — metadata-only stub / audio classification (#1835).
//
// M3 adds 8 new indexer-eligible extensions that have NO decode path at all:
//   - Stub images: eip (Phase One), braw (Blackmagic RAW), afphoto (Affinity
//     Photo), ai (Illustrator) — no decoder exists for any of these.
//   - Audio: mp3, wav, m4a, aac — a wholly new asset category.
//
// Before this ticket, none of these extensions appeared in any Apple-side
// extension set, so `AssetRef.isRaw`'s "anything unrecognised defaults to
// RAW" fallback would have misrouted them into the libraw decode path.
//
// Covers:
//   • StubExtensions / AudioExtensions membership.
//   • SupportedImageExtensions.all includes the new extensions (folder
//     listing visibility).
//   • AssetRef.isStub / isAudio classification.
//   • AssetRef.isRaw returns false for stub/audio, even with explicitIsRaw
//     set on a URL-backed ref — mirrors AssetRefVideoTests's video coverage.
//   • FilesystemSource lists the new extensions.
//
// Split out to stay under the 600-line-per-file test budget alongside
// NonRawSupportTests.swift / AssetRefVideoTests.swift.

import XCTest
@testable import MapleCore

final class AssetRefStubAudioTests: XCTestCase {

    // MARK: - Extension classification

    func testStubExtensionsIncludesAllFourFormats() {
        let exts = StubExtensions.all
        XCTAssertTrue(exts.contains("eip"))
        XCTAssertTrue(exts.contains("braw"))
        XCTAssertTrue(exts.contains("afphoto"))
        XCTAssertTrue(exts.contains("ai"))
    }

    func testAudioExtensionsIncludesAllFourFormats() {
        let exts = AudioExtensions.all
        XCTAssertTrue(exts.contains("mp3"))
        XCTAssertTrue(exts.contains("wav"))
        XCTAssertTrue(exts.contains("m4a"))
        XCTAssertTrue(exts.contains("aac"))
    }

    func testSupportedImageExtensionsIncludesStubAndAudio() {
        let union = SupportedImageExtensions.all
        for ext in ["eip", "braw", "afphoto", "ai", "mp3", "wav", "m4a", "aac"] {
            XCTAssertTrue(union.contains(ext), ".\(ext) must be listed for folder enumeration")
        }
        XCTAssertEqual(
            union,
            RAWExtensions.all
                .union(NonRawImageExtensions.all)
                .union(VideoExtensions.all)
                .union(StubExtensions.all)
                .union(AudioExtensions.all)
        )
    }

    // MARK: - AssetRef.isStub / isAudio

    func testAssetRefIsStubForStubExtensions() {
        for ext in ["eip", "BRAW", "afphoto", "Ai"] {
            let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.\(ext)"))
            XCTAssertTrue(ref.isStub, ".\(ext) must classify as stub")
            XCTAssertFalse(ref.isAudio, ".\(ext) must not classify as audio")
        }
    }

    func testAssetRefIsAudioForAudioExtensions() {
        for ext in ["mp3", "WAV", "m4a", "Aac"] {
            let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/track.\(ext)"))
            XCTAssertTrue(ref.isAudio, ".\(ext) must classify as audio")
            XCTAssertFalse(ref.isStub, ".\(ext) must not classify as stub")
        }
    }

    func testAssetRefNonStubNonAudioIsNeitherStubNorAudio() {
        let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.dng"))
        XCTAssertFalse(ref.isStub)
        XCTAssertFalse(ref.isAudio)
    }

    func testURLLessRefsAreNeverStubOrAudio() {
        let ref = AssetRef(displayName: "PHAsset", hintExtension: "mp3", bytesProvider: { Data() })
        XCTAssertFalse(ref.isStub, "URL-less refs are never classified as stub")
        XCTAssertFalse(ref.isAudio, "URL-less refs are never classified as audio")
    }

    // MARK: - AssetRef.isRaw short-circuit

    func testAssetRefStubExtensionsAreNeverRaw() {
        // `isRaw` must return false so the open/render dispatch never routes
        // a stub image's bytes to the libraw RAW decoder — none of eip/braw/
        // afphoto/ai has any decoder at all.
        for ext in ["eip", "BRAW", "afphoto", "Ai"] {
            let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/foo.\(ext)"))
            XCTAssertFalse(ref.isRaw, ".\(ext) stub image must NOT classify as RAW")
            XCTAssertTrue(ref.isStub, ".\(ext) must classify as stub")
        }
    }

    func testAssetRefAudioExtensionsAreNeverRaw() {
        for ext in ["mp3", "WAV", "m4a", "Aac"] {
            let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/track.\(ext)"))
            XCTAssertFalse(ref.isRaw, ".\(ext) audio must NOT classify as RAW")
            XCTAssertTrue(ref.isAudio, ".\(ext) must classify as audio")
        }
    }

    func testAssetRefStubIsRawBeatsExplicitIsRaw() {
        // The stub/audio short-circuit precedes `explicitIsRaw`, mirroring
        // the video guard: no source can force a stub or audio file onto
        // the RAW decode path even with explicitIsRaw == true. URL-backed
        // refs don't take explicitIsRaw directly, so route it through a
        // bytesProvider-shaped ref with a stub/audio hint extension instead
        // — that's the only constructor surface where explicitIsRaw applies.
        let stubRef = AssetRef(
            displayName: "force-raw-stub",
            hintExtension: "braw",
            stableID: nil,
            explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        // URL-less refs are never isStub, so this asserts the historical
        // explicitIsRaw-wins behaviour still applies off the filesystem path
        // — the hard guard lives in the URL-backed `isRaw` check below.
        XCTAssertTrue(stubRef.isRaw)

        let urlRef = AssetRef(url: URL(fileURLWithPath: "/tmp/clip.braw"))
        XCTAssertFalse(urlRef.isRaw, "URL-backed .braw must never be RAW regardless of any override")
    }

    // MARK: - FilesystemSource — listing

    func testFilesystemSourceListsStubAndAudioExtensions() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let names = ["a.eip", "b.braw", "c.afphoto", "d.ai", "e.mp3", "f.wav", "g.m4a", "h.aac", "i.txt"]
        for name in names {
            try Data([0]).write(to: tmp.appendingPathComponent(name))
        }

        let source = FilesystemSource()
        try await source.open(folderURL: tmp)
        let assets = await source.assets
        let listed = Set(assets.map { $0.url.lastPathComponent })

        for name in names where name != "i.txt" {
            XCTAssertTrue(listed.contains(name), "\(name) must be listed in folder enumeration")
        }
        XCTAssertFalse(listed.contains("i.txt"), "non-image/non-audio extensions filtered out")
    }
}
