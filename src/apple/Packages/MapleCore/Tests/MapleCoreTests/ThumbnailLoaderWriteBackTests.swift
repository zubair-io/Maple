// ThumbnailLoaderWriteBackTests.swift — exercises the `writeThumb(_:for:)`
// wiring in `ThumbnailLoader.load(for:from:)` (#2690).
//
// The render-from-bytes fallback itself runs the FFI and isn't
// deterministic in a unit test without a real RAW fixture (see
// ThumbnailLoaderTests.swift's header and ThumbnailLoaderSourcelessTests.swift) —
// there is no mockable seam for `PipelineRenderer`, confirmed again while
// adding this file, so none of these tests drive a real RAW decode. Two
// groups of coverage instead:
//
//   1. Assertions that don't require the fallback to run at all: `writeThumb`
//      must NEVER fire on a `source.thumb()` hit (the fallback never
//      executes), and a source that never overrides `writeThumb` (the
//      `ImageSource` protocol's default no-op) must not break anything for
//      the existing hit path.
//   2. `ThumbnailLoader.persistFallbackRender` — the dispatch/persistence
//      logic `load(for:from:)`'s fallback delegates to AFTER a render
//      succeeds — is unit-testable directly without touching
//      `PipelineRenderer` at all, so the (post-review) fire-and-forget
//      write-back behavior and the on-share-vs-local-grid byte selection
//      are pinned by driving THAT function directly with synthetic
//      "already rendered" bytes and a gated stub source.

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

    // MARK: - persistFallbackRender: fire-and-forget dispatch (#2690 review)

    /// A `writeThumb` that PARKS on a continuation until the test releases
    /// it — lets a test observe "has the write-back finished" as a
    /// deterministic boolean instead of guessing from timing alone.
    actor GatedWriteBackSource: ImageSource {
        private var gate: CheckedContinuation<Void, Never>?
        private(set) var writeThumbCalls: [(id: String, bytes: Data)] = []
        private(set) var writeThumbCompleted = false
        /// True once a `writeThumb` call is actually parked on `gate` —
        /// the detached Task in `persistFallbackRender` needs a moment to
        /// get scheduled, so a caller must poll THIS (not just call
        /// `release()` immediately) or `release()` can race a `gate` that
        /// hasn't been set yet and silently no-op.
        private(set) var isParked = false

        func images() async throws -> [ImageRef] { [] }
        func thumb(for ref: ImageRef) async throws -> Data? { nil }
        func preview(for ref: ImageRef) async throws -> Data? { nil }
        func rawBytes(for ref: ImageRef) async throws -> Data { Data() }
        func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
        func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }

        func writeThumb(_ data: Data, for ref: ImageRef) async {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                gate = cont
                isParked = true
            }
            writeThumbCalls.append((id: ref.id, bytes: data))
            writeThumbCompleted = true
        }

        /// Releases a `writeThumb` call parked on the gate. Callers must
        /// wait for `isParked` first — see its doc comment.
        func release() {
            gate?.resume()
            gate = nil
        }
    }

    /// The BLOCKING finding from the #2690 review: awaiting
    /// `source.writeThumb` inline before returning would hold every grid
    /// cell — and the decode-slot gate — through up to four SMB round
    /// trips per cold miss, serializing a 200-asset browse behind network
    /// writes. `persistFallbackRender` must return as soon as the LOCAL
    /// disk-cache write lands, with the write-back running independently.
    func testPersistFallbackRenderReturnsBeforeTheWriteBackCompletes() async throws {
        let tmp = freshCacheDir()
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        await ThumbnailDiskCache.shared.configure(folderURL: tmp)

        let source = GatedWriteBackSource()
        let ref = ImageRef(id: "maple:gated0001", displayName: "IMG_1.dng")
        let key = "maple:gated0001"
        let localData = Data([0x01, 0x02])
        let onShareData = Data([0x11, 0x22, 0x33])

        // Returns even though `source.writeThumb` is parked on a gate that
        // is never released during this call — proves the write-back is
        // NOT awaited inline.
        await ThumbnailLoader.persistFallbackRender(
            localData: localData, onShareData: onShareData,
            key: key, source: source, ref: ref)

        // The local cache write is synchronous (awaited inside
        // `persistFallbackRender`), so it must already be visible.
        let cached = await ThumbnailDiskCache.shared.thumbnailData(forKey: key)
        XCTAssertEqual(cached, localData)

        // The write-back itself must still be in flight — never finished —
        // confirming `persistFallbackRender`'s return above did not wait
        // for it.
        let completedBeforeRelease = await source.writeThumbCompleted
        XCTAssertFalse(completedBeforeRelease,
                       "the write-back must not be finished right after persistFallbackRender returns")

        // Wait for the detached Task to actually reach the gate (it needs
        // to get scheduled first — there's no synchronization point with
        // `persistFallbackRender`'s return for that), THEN release it and
        // let the write-back finish.
        var parked = false
        for _ in 0..<50 {
            if await source.isParked { parked = true; break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(parked, "the detached write-back Task should reach the gate shortly after being fired")
        await source.release()
        var completed = false
        for _ in 0..<50 {
            if await source.writeThumbCompleted { completed = true; break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(completed, "write-back should complete shortly after its gate is released")

        let calls = await source.writeThumbCalls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.id, ref.id)
        XCTAssertEqual(calls.first?.bytes, onShareData,
                       "write-back must receive the ON-SHARE candidate bytes, never the local-grid bytes")
    }

    /// No on-share candidate (e.g. `encodeThumbnail` at the on-share
    /// size/quality failed) — the write-back must be skipped entirely, not
    /// attempted with the wrong (local-grid) bytes as a fallback.
    func testPersistFallbackRenderSkipsWriteBackWhenThereIsNoOnShareCandidate() async throws {
        let tmp = freshCacheDir()
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        await ThumbnailDiskCache.shared.configure(folderURL: tmp)

        let source = RecordingSource(canned: nil)
        let ref = ImageRef(id: "maple:noonshare0001", displayName: "IMG_2.dng")
        let key = "maple:noonshare0001"
        let localData = Data([0x09])

        await ThumbnailLoader.persistFallbackRender(
            localData: localData, onShareData: nil, key: key, source: source, ref: ref)

        let cached = await ThumbnailDiskCache.shared.thumbnailData(forKey: key)
        XCTAssertEqual(cached, localData)
        let writeCalls = await source.writeThumbCalls
        XCTAssertTrue(writeCalls.isEmpty)
    }
}
