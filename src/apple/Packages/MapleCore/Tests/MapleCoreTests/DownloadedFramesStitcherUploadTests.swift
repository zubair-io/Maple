// DownloadedFramesStitcherUploadTests.swift — a stitch of downloaded frames
// whose panorama reaches the server without its crop sidecar (#5628).

import Foundation
import Testing
import os

@testable import MapleCore

extension DownloadedFramesStitcherTests {
  @Test func aRefusedCropSidecarTakesThePanoramaBackAndKeepsTheStitchAndTheCache() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "stitched-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let stitched = try PanoTestPanorama.stitched(in: directory)
    let frames = ["a.dng", "b.dng"].map { AssetRef(url: directory.appendingPathComponent($0)) }
    let calls = OSAllocatedUnfairLock(initialState: (removed: [String?](), finished: false))
    let stitcher = DownloadedFramesStitcher(
      device: LocalCopyRecorder(output: stitched.outputURL), cloudFrames: frames,
      localFrames: frames,
      addToLibrary: { result in
        try await PanoServerUpload.add(result, target: "Panoramas/p.png") { path, _ in
          path.hasSuffix(".xmp") ? nil : ("/srv/\(path)", "asset-1")
        } remove: { uploaded in
          calls.withLock { $0.removed.append(uploaded.assetID) }
        }
      },
      finished: { calls.withLock { $0.finished = true } })

    await #expect(throws: PanoFrameDownloadError.uploadRefused("p.xmp")) {
      _ = try await stitcher.stitch(
        assets: frames, options: .default, alignment: nil, maxCanvasPixels: nil,
        progress: { _, _ in })
    }

    #expect(calls.withLock { $0.removed } == ["asset-1"])
    #expect(!calls.withLock { $0.finished })
    #expect(FileManager.default.fileExists(atPath: stitched.outputURL.path))
  }
}
