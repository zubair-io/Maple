// ThumbnailLoaderWriteBackTests.swift — exercises the `writeThumb(_:for:)`
// wiring in `ThumbnailLoader.load(for:from:)` (#2690).
//
// The render-from-bytes fallback itself runs the FFI and isn't
// deterministic in a unit test without a real RAW fixture (see
// ThumbnailLoaderTests.swift's header and ThumbnailLoaderSourcelessTests.swift) —
// so, matching those files' existing strategy, the assertions here are the
// ones that don't require the fallback to actually run: `writeThumb` must
// NEVER fire on a `source.thumb()` hit (the fallback — and therefore the
// write-back — never executes), and a source that never overrides
// `writeThumb` (the `ImageSource` protocol's default no-op) must not break
// anything for the existing hit path.

import XCTest
@testable import MapleCore

final class ThumbnailLoaderWriteBackTests: XCTestCase {

    /// Records both `thumb(for:)` and `writeThumb(_:for:)` calls.
    actor RecordingSource: ImageSource {
        var thumbCalls: [String] = []
        var writeThumbCalls: [(id: String, bytes: Data)] = []
        let canned: Data?

        init(canned: Data?) { self.canned = canned }

        func images() async throws -> [ImageRef] { [] }

        func thumb(for ref: ImageRef) async throws -> Data? {
            thumbCalls.append(ref.id)
            return canned
        }

        func writeThumb(_ data: Data, for ref: ImageRef) async {
            writeThumbCalls.append((id: ref.id, bytes: data))
        }

        func preview(for ref: ImageRef) async throws -> Data? { nil }
        func rawBytes(for ref: ImageRef) async throws -> Data {
            XCTFail("rawBytes must not be invoked when thumb() succeeds")
            return Data()
        }
        func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
        func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
    }

    private func freshCacheDir() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-thumb-writeback-\(UUID().uuidString)")
    }

    // MARK: - writeThumb must not fire on a source.thumb() hit

    func testWriteThumbIsNeverCalledWhenSourceThumbHits() async throws {
        let tmp = freshCacheDir()
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        await ThumbnailDiskCache.shared.configure(folderURL: tmp)

        let canned = Data([0xAA, 0xBB])
        let source = RecordingSource(canned: canned)
        let stableID = "maple:onshare0001"
        let asset = AssetRef(
            displayName: "IMG_1.dng",
            hintExtension: "dng",
            stableID: stableID,
            bytesProvider: {
                XCTFail("bytesProvider must not be invoked when source.thumb() succeeds")
                return Data()
            }
        )

        let loader = ThumbnailLoader()
        let got = await loader.load(for: asset, from: source)

        XCTAssertEqual(got, canned)
        let thumbCalls = await source.thumbCalls
        XCTAssertEqual(thumbCalls, [stableID])
        let writeCalls = await source.writeThumbCalls
        XCTAssertTrue(writeCalls.isEmpty,
                      "the fallback (and therefore the write-back) must never run on a thumb() hit")
    }

    // MARK: - Fallback provider fails -> no bytes to write back

    func testWriteThumbIsNeverCalledWhenTheFallbackProviderFails() async throws {
        let tmp = freshCacheDir()
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        await ThumbnailDiskCache.shared.configure(folderURL: tmp)

        let source = RecordingSource(canned: nil)
        let stableID = "maple:onshare0002"
        struct ProviderFailure: Error {}
        let asset = AssetRef(
            displayName: "IMG_2.dng",
            hintExtension: "dng",
            stableID: stableID,
            bytesProvider: { throw ProviderFailure() }
        )

        let loader = ThumbnailLoader()
        let got = await loader.load(for: asset, from: source)

        XCTAssertNil(got, "no source hit and a failing fallback provider — the loader has nothing to return")
        let writeCalls = await source.writeThumbCalls
        XCTAssertTrue(writeCalls.isEmpty, "a failed render must never reach the write-back call")
    }

    // MARK: - Default no-op does not break a source that doesn't override writeThumb

    func testSourceWithoutWriteThumbOverrideStillServesThumbHits() async throws {
        let tmp = freshCacheDir()
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        await ThumbnailDiskCache.shared.configure(folderURL: tmp)

        // A minimal conformer that relies entirely on ImageSource's default
        // `writeThumb` no-op (never declares its own) — this is what
        // FilesystemSource/PhotoKitSource/CloudSource/ComposedSource do
        // today, and what any future source gets automatically.
        actor DefaultWriteThumbSource: ImageSource {
            let canned: Data
            init(canned: Data) { self.canned = canned }
            func images() async throws -> [ImageRef] { [] }
            func thumb(for ref: ImageRef) async throws -> Data? { canned }
            func preview(for ref: ImageRef) async throws -> Data? { nil }
            func rawBytes(for ref: ImageRef) async throws -> Data { Data() }
            func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
            func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
        }

        let canned = Data([0x01, 0x02, 0x03])
        let source = DefaultWriteThumbSource(canned: canned)
        let asset = AssetRef(
            displayName: "IMG_3.dng", hintExtension: "dng",
            stableID: "maple:defaultwritethumb", bytesProvider: { Data() })

        let loader = ThumbnailLoader()
        let got = await loader.load(for: asset, from: source)
        XCTAssertEqual(got, canned)
    }
}
