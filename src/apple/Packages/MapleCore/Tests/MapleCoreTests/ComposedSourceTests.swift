// ComposedSourceTests — prove the §09 routing table.

import XCTest
@testable import MapleCore

// MARK: - Fake sources

/// Records which methods were called so tests can assert routing.
actor RecordingSource: ImageSource {

    enum Behavior {
        case ok
        case readOnly
        case fail
    }

    var calls: [String] = []
    var writeBehavior: Behavior = .ok
    let sentinelRawBytes: Data
    let sentinelImages: [ImageRef]
    let sentinelSearch: [ImageRef]?

    init(sentinelRawBytes: Data = Data(),
         sentinelImages: [ImageRef] = [],
         sentinelSearch: [ImageRef]? = nil) {
        self.sentinelRawBytes = sentinelRawBytes
        self.sentinelImages = sentinelImages
        self.sentinelSearch = sentinelSearch
    }

    func setWriteBehavior(_ b: Behavior) { writeBehavior = b }

    func images() async throws -> [ImageRef] {
        calls.append("images")
        return sentinelImages
    }

    func thumb(for ref: ImageRef) async throws -> Data? {
        calls.append("thumb")
        return nil
    }

    func preview(for ref: ImageRef) async throws -> Data? {
        calls.append("preview")
        return nil
    }

    func rawBytes(for ref: ImageRef) async throws -> Data {
        calls.append("rawBytes")
        return sentinelRawBytes
    }

    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        calls.append("writeXMP")
        switch writeBehavior {
        case .ok:       return
        case .readOnly: throw ImageSourceError.readOnly("test")
        case .fail:     throw ImageSourceError.unsupported("test")
        }
    }

    func search(_ query: SearchQuery) async throws -> [ImageRef]? {
        calls.append("search")
        return sentinelSearch
    }
}

// MARK: - Tests

final class ComposedSourceTests: XCTestCase {

    private func ref() -> ImageRef {
        ImageRef(id: "abc", displayName: "IMG.CR3")
    }

    func testRawBytesRoutesToBytesSource() async throws {
        let payload = Data([9, 9, 9])
        let metadata = RecordingSource()
        let bytes = RecordingSource(sentinelRawBytes: payload)
        let composed = ComposedSource(metadata: metadata, bytes: bytes,
                                      coverage: .same(folder: "/photos"))

        let got = try await composed.rawBytes(for: ref())
        XCTAssertEqual(got, payload)

        let metaCalls = await metadata.calls
        let bytesCalls = await bytes.calls
        XCTAssertTrue(metaCalls.isEmpty, "metadata should not be touched for rawBytes")
        XCTAssertEqual(bytesCalls, ["rawBytes"])
    }

    func testWriteXMPFallsBackWhenBytesReadOnly() async throws {
        let metadata = RecordingSource()
        let bytes = RecordingSource()
        await bytes.setWriteBehavior(.readOnly)

        let composed = ComposedSource(metadata: metadata, bytes: bytes,
                                      coverage: .same(folder: "/photos"))
        try await composed.writeXMP(
            Sidecar(model: .default, culling: CullingState()),
            for: ref())

        let metaCalls = await metadata.calls
        let bytesCalls = await bytes.calls
        XCTAssertEqual(bytesCalls, ["writeXMP"])
        XCTAssertEqual(metaCalls, ["writeXMP"], "fallback must reach metadata")
    }

    func testWriteXMPStaysOnBytesWhenSucceeds() async throws {
        let metadata = RecordingSource()
        let bytes = RecordingSource()

        let composed = ComposedSource(metadata: metadata, bytes: bytes,
                                      coverage: .same(folder: "/photos"))
        try await composed.writeXMP(
            Sidecar(model: .default, culling: CullingState()),
            for: ref())

        let metaCalls = await metadata.calls
        let bytesCalls = await bytes.calls
        XCTAssertEqual(bytesCalls, ["writeXMP"])
        XCTAssertTrue(metaCalls.isEmpty, "no fallback when bytes write succeeds")
    }

    func testSearchRoutesToMetadata() async throws {
        let hits = [ImageRef(id: "x", displayName: "x.dng")]
        let metadata = RecordingSource(sentinelSearch: hits)
        let bytes = RecordingSource()
        let composed = ComposedSource(metadata: metadata, bytes: bytes,
                                      coverage: .same(folder: "/photos"))

        let got = try await composed.search(SearchQuery(q: "paris"))
        XCTAssertEqual(got?.count, 1)

        let metaCalls = await metadata.calls
        let bytesCalls = await bytes.calls
        XCTAssertEqual(metaCalls, ["search"])
        XCTAssertTrue(bytesCalls.isEmpty)
    }

    func testImagesAndThumbAndPreviewRouteToMetadata() async throws {
        let metadata = RecordingSource(sentinelImages: [ref()])
        let bytes = RecordingSource()
        let composed = ComposedSource(metadata: metadata, bytes: bytes,
                                      coverage: .same(folder: "/photos"))

        _ = try await composed.images()
        _ = try await composed.thumb(for: ref())
        _ = try await composed.preview(for: ref())

        let metaCalls = await metadata.calls
        let bytesCalls = await bytes.calls
        XCTAssertEqual(metaCalls, ["images", "thumb", "preview"])
        XCTAssertTrue(bytesCalls.isEmpty)
    }
}
