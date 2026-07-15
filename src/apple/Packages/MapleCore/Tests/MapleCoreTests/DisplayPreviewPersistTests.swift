// DisplayPreviewPersistTests.swift — the #2009 developed-preview persist:
// the sink destinations (local file / cloud PUT) and the EditSession
// idle-debounce + exit trigger.

import CoreImage
import Foundation
import XCTest

@testable import MapleCore

/// Collects everything written, for asserting the persist trigger fired.
private actor SpyPreviewSink: DisplayPreviewSink {
    private(set) var writes: [Data] = []
    func write(_ bytes: Data) async { writes.append(bytes) }
    func count() -> Int { writes.count }
    func last() -> Data? { writes.last }
}

final class DisplayPreviewPersistTests: XCTestCase {

    private func solidCIImage(_ w: Int, _ h: Int) -> CIImage {
        CIImage(color: .init(red: 0.4, green: 0.6, blue: 0.2, alpha: 1))
            .cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
    }

    // MARK: - Local sink

    func testLocalSinkWritesBytesToPreviewURL() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("localsink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let assetURL = dir.appendingPathComponent("IMG.CR2")
        let previewURL = MapleSidecarPaths.previewURL(for: assetURL)

        let sink = LocalDisplayPreviewSink(previewURL: previewURL)
        let payload = Data([0x01, 0x02, 0x03, 0x04])
        // Creates the `.maple/previews/` dir on demand and writes atomically.
        await sink.write(payload)

        XCTAssertEqual(previewURL.lastPathComponent, "IMG.CR2.avif")
        XCTAssertEqual(try Data(contentsOf: previewURL), payload)
    }

    // MARK: - Cloud sink request contract

    func testCloudSinkBuildsCanonicalPutRequest() throws {
        let server = URL(string: "https://maple.example.com")!
        let path = "/lib/Photos/2024/IMG 1234.CR2" // space forces urlencoding
        let bytes = Data([0xAA, 0xBB, 0xCC])
        let req = try XCTUnwrap(
            CloudDisplayPreviewSink.makeRequest(server: server, assetPath: path, bytes: bytes))

        XCTAssertEqual(req.httpMethod, "PUT")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "image/avif")
        XCTAssertEqual(req.httpBody, bytes)
        let url = try XCTUnwrap(req.url)
        XCTAssertEqual(url.path, "/api/preview")
        // The original asset path rides as an urlencoded `path` query item.
        let comps = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(
            comps.queryItems, [URLQueryItem(name: "path", value: path)])
        XCTAssertTrue(url.absoluteString.contains("path=/lib/Photos/2024/IMG%201234.CR2"),
                      "space in the asset path must be percent-encoded: \(url.absoluteString)")
    }

    // MARK: - EditSession idle/exit trigger

    /// A sourceless session with an injected sink: scheduling captures a frame
    /// but does NOT write per call (idle debounce); the exit flush persists
    /// exactly once, and it's a real AVIF.
    @MainActor
    func testScheduleThenFlushPersistsOnceAsAVIF() async throws {
        let sink = SpyPreviewSink()
        let asset = AssetRef(displayName: "x.dng", hintExtension: "dng",
                             bytesProvider: { throw CancellationError() })
        let session = EditSession(asset: asset, remotePreviewSink: sink)

        // Two rapid captures (as a slider drag would) — the second supersedes
        // the first; neither has written yet (the debounce hasn't elapsed).
        session.scheduleDisplayPreviewPersist(solidCIImage(2_000, 1_500))
        session.scheduleDisplayPreviewPersist(solidCIImage(2_000, 1_500))
        let beforeFlush = await sink.count()
        XCTAssertEqual(beforeFlush, 0, "must not write per schedule — idle debounce")

        await session.flushDisplayPreviewPersist()
        let afterFlush = await sink.count()
        XCTAssertEqual(afterFlush, 1, "exit flush persists exactly once")
        let lastWrite = await sink.last()
        let bytes = try XCTUnwrap(lastWrite)
        XCTAssertEqual(bytes[4..<8], Data("ftyp".utf8), "persisted preview must be AVIF")
        // Downscaled to the tier long edge (2000 → 1280).
        let src = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
        let img = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        XCTAssertEqual(max(img.width, img.height), Int(ThumbnailLoader.displayPreviewLongEdge))

        // A second flush with nothing pending is a no-op.
        await session.flushDisplayPreviewPersist()
        let afterSecondFlush = await sink.count()
        XCTAssertEqual(afterSecondFlush, 1)
    }

    /// No sink (sourceless, no remote) → scheduling is a silent no-op.
    @MainActor
    func testNoSinkNoPersist() async {
        let asset = AssetRef(displayName: "y.dng", hintExtension: "dng",
                             bytesProvider: { throw CancellationError() })
        let session = EditSession(asset: asset)
        XCTAssertNil(session.previewSink)
        session.scheduleDisplayPreviewPersist(solidCIImage(800, 600))
        await session.flushDisplayPreviewPersist() // must not crash
    }
}
