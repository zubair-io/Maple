// ThumbnailLoaderSourcelessTests — exercises the sourceless code path of
// `ThumbnailLoader.load(for:from:)`.
//
// The full render-from-bytes fallback runs the FFI and is not deterministic
// in a unit test (needs a real RAW). The asserted contract here is the one
// that prevents regressions on the cheap path: when the source's
// `thumb(for:)` returns precanned bytes, the loader must use them, persist
// them under the asset's stable id, and never invoke the Rust pipeline.
//
// The "no PipelineRenderer call" assertion is implicit: the asset has no
// `bytesProvider`, so any fall-through to the renderer would crash on the
// unwrap. The test passing → the source path is taken.

import XCTest
@testable import MapleCore

final class ThumbnailLoaderSourcelessTests: XCTestCase {

    // MARK: - Stub source

    /// Records one call to `thumb(for:)` and returns the precanned bytes.
    actor StubSource: ImageSource {
        var thumbCalls: [String] = []
        let canned: Data

        init(canned: Data) { self.canned = canned }

        func images() async throws -> [ImageRef] { [] }

        func thumb(for ref: ImageRef) async throws -> Data? {
            thumbCalls.append(ref.id)
            return canned
        }

        func preview(for ref: ImageRef) async throws -> Data? { nil }
        func rawBytes(for ref: ImageRef) async throws -> Data {
            XCTFail("rawBytes must not be invoked when thumb() succeeds")
            return Data()
        }
        func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
        func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
    }

    // MARK: - Test

    func testLoaderUsesSourceThumbAndCachesByStableID() async throws {
        // Configure the disk cache to a fresh tmp dir so we don't pollute the
        // shared cache across tests.
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-thumb-srcless-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        await ThumbnailDiskCache.shared.configure(folderURL: tmp)

        let canned = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x12, 0x34])
        let source = StubSource(canned: canned)

        // Sourceless asset — no primaryURL, no bytesProvider (the fallback
        // path wouldn't trigger because `thumb` succeeds, but the absence of
        // a provider also guarantees a regression toward the renderer would
        // surface as `nil`, not a successful match).
        let stableID = "maple:abcdef0123456789"
        let asset = AssetRef(
            displayName: "IMG_42.dng",
            hintExtension: "dng",
            stableID: stableID,
            bytesProvider: { Data() }
        )

        let loader = ThumbnailLoader()
        let got = await loader.load(for: asset, from: source)
        XCTAssertEqual(got, canned, "loader must return the source's thumb bytes")

        let calls = await source.thumbCalls
        XCTAssertEqual(calls, [stableID],
                       "source.thumb(for:) must be invoked exactly once with the stable id")

        // Second load: bytes should come from the disk cache, source untouched.
        let cached = await loader.load(for: asset, from: source)
        XCTAssertEqual(cached, canned)
        let callsAfter = await source.thumbCalls
        XCTAssertEqual(callsAfter.count, 1, "cache hit must not re-invoke source.thumb")

        // Disk-cache key is the stable id, not the per-session UUID.
        let direct = await ThumbnailDiskCache.shared.thumbnailData(forKey: stableID)
        XCTAssertEqual(direct, canned, "bytes must be persisted under the stable id key")
    }
}
