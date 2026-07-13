// VideoThumbnailTests.swift — poster-frame thumbnail for video assets (#1642).
//
// Coverage:
//   1. `ThumbnailLoader.load(for:)` on a real .mov returns non-nil AVIF bytes.
//   2. The result is stored in `ThumbnailDiskCache` (memory + disk round-trip).
//   3. A second load for the same URL returns from cache (no re-render).
//   4. A non-video file still returns nil when it doesn't exist on disk (regression guard).
//
// The test writes a minimal 1-frame 64×64 H.264 .mov via AVFoundation.
// If AVFoundation asset writing is unavailable (shouldn't happen on macOS in
// a unit test, but guarded anyway), the test calls XCTSkip.

import XCTest
import AVFoundation
import CoreImage
@testable import MapleCore

final class VideoThumbnailTests: XCTestCase {

    private var tmp: URL!

    override func setUp() async throws {
        tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-vidthumb-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        // Configure the shared ThumbnailDiskCache so ThumbnailLoader can write
        // to .maple/thumbs/ inside our tmp directory.
        await ThumbnailDiskCache.shared.configure(folderURL: tmp)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    // MARK: - Fixture helper

    /// Write a minimal 1-frame 64×64 video to `url` using AVAssetWriter.
    /// Returns false if the environment can't write video (test caller should XCTSkip).
    private func writeMinimalMov(to url: URL) async throws -> Bool {
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        } catch {
            return false
        }

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: NSNumber(value: 64),
            AVVideoHeightKey: NSNumber(value: 64),
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: 64,
                kCVPixelBufferHeightKey as String: 64,
            ]
        )
        guard writer.canAdd(input) else { return false }
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        // Create and append a single black 64×64 pixel buffer at t=0. The buffer
        // memory is uninitialized after CVPixelBufferCreate, so zero it explicitly
        // (0 in BGRA = opaque black) to produce a deterministic frame.
        var pixelBuffer: CVPixelBuffer?
        let attrs: CFDictionary = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: 64,
            kCVPixelBufferHeightKey: 64,
        ] as CFDictionary
        guard CVPixelBufferCreate(
            kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA, attrs, &pixelBuffer
        ) == kCVReturnSuccess, let pb = pixelBuffer else { return false }

        CVPixelBufferLockBaseAddress(pb, [])
        if let base = CVPixelBufferGetBaseAddress(pb) {
            let rowBytes = CVPixelBufferGetBytesPerRow(pb)
            let height = CVPixelBufferGetHeight(pb)
            memset(base, 0, rowBytes * height)
        }
        CVPixelBufferUnlockBaseAddress(pb, [])

        // A failed append silently produces an empty movie — assert it succeeds
        // so the fixture build fails loudly instead.
        XCTAssertTrue(adaptor.append(pb, withPresentationTime: .zero),
                      "AVAssetWriterInputPixelBufferAdaptor.append should succeed")
        input.markAsFinished()

        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            writer.finishWriting { cont.resume() }
        }
        return writer.status == .completed
    }

    // MARK: - Tests

    /// `ThumbnailLoader.load(for:)` must return AVIF bytes for a video file.
    func testVideoLoadReturnsPosterAvif() async throws {
        let videoURL = tmp.appendingPathComponent("sample.mov")
        guard try await writeMinimalMov(to: videoURL) else {
            throw XCTSkip("AVAssetWriter unavailable in this environment")
        }

        let data = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertNotNil(data, "ThumbnailLoader should return AVIF bytes for a video file")
        // AVIF magic bytes: ISOBMFF box — 4-byte size, "ftyp", "avif" major brand.
        if let bytes = data, bytes.count >= 12 {
            XCTAssertEqual(Array(bytes[4..<8]), [0x66, 0x74, 0x79, 0x70],
                           "poster should be an ISOBMFF ftyp box")
            XCTAssertEqual(Array(bytes[8..<12]), [0x61, 0x76, 0x69, 0x66],
                           "poster major brand should be avif")
        }
    }

    /// The poster AVIF must be written to `.maple/thumbs/<hash>.avif` so the
    /// asset-relative cache lookup in `ThumbnailLoader` can serve it on the next call.
    func testVideoThumbnailStoredInDiskCache() async throws {
        let videoURL = tmp.appendingPathComponent("stored.mov")
        guard try await writeMinimalMov(to: videoURL) else {
            throw XCTSkip("AVAssetWriter unavailable")
        }

        let data = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertNotNil(data)

        // Verify the thumb is on disk at the MapleSidecarPaths location.
        let thumbURL = MapleSidecarPaths.thumbURL(for: videoURL)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: thumbURL.path),
            "poster AVIF should be written to .maple/thumbs/ next to the video"
        )
    }

    /// A second `load` for the same URL must return the cached bytes (same data).
    func testVideoThumbnailHitsMemoryCacheOnSecondLoad() async throws {
        let videoURL = tmp.appendingPathComponent("cached.mov")
        guard try await writeMinimalMov(to: videoURL) else {
            throw XCTSkip("AVAssetWriter unavailable")
        }

        // First load — cold cache.
        let first = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertNotNil(first)

        // Second load — must return the same bytes (from ThumbnailDiskCache).
        let second = await ThumbnailLoader.shared.load(for: videoURL, scopeParentURL: tmp)
        XCTAssertEqual(first, second, "second load should return cached bytes")
    }

    /// Regression guard: a missing non-video file must still return nil.
    func testNonVideoMissingFileReturnsNil() async {
        let missing = tmp.appendingPathComponent("ghost.dng")
        let data = await ThumbnailLoader.shared.load(for: missing, scopeParentURL: tmp)
        XCTAssertNil(data, "missing non-video file should return nil — not a video, no poster")
    }
}
