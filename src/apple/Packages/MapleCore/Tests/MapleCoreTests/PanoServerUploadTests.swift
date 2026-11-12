// PanoServerUploadTests.swift — the crop sidecar travels with an on-device
// panorama added to the server (#5608), and a panorama whose sidecar does not
// get there is removed from the server again (#5628).

import Foundation
import Testing
import os

@testable import MapleCore

private struct ConnectionLost: Error, Equatable {}

@Suite struct PanoServerUploadTests {
  private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "upload-\(UUID().uuidString)", isDirectory: true)
  private let sent = OSAllocatedUnfairLock<[String]>(initialState: [])
  private let removed = OSAllocatedUnfairLock<[String]>(initialState: [])
  private let uploadedPanorama = "/srv/2026/Panoramas/p.png#asset-1"

  /// Adds `panorama` to a server that takes the PNG and answers the sidecar
  /// with `sidecar`; `remove` is how removing the PNG again turns out.
  private func add(
    _ panorama: PanoResult,
    sidecar: @Sendable (String) async throws -> PanoServerUpload.Uploaded? = { ($0, nil) },
    remove: @escaping @Sendable () async throws -> Void = {}
  ) async throws -> PanoResult {
    try await PanoServerUpload.add(panorama, target: "2026/Panoramas/p.png") { path, file in
      sent.withLock { $0.append("\(path)=\(file.lastPathComponent)") }
      guard path.hasSuffix(".xmp") else { return ("/srv/\(path)", "asset-1") }
      return try await sidecar(path)
    } remove: { [removed] uploaded in
      removed.withLock { $0.append("\(uploaded.absPath)#\(uploaded.assetID ?? "-")") }
      try await remove()
    }
  }

  @Test func theCropSidecarIsUploadedAfterThePanoramaBesideIt() async throws {
    defer { try? FileManager.default.removeItem(at: directory) }
    let panorama = try PanoTestPanorama.stitched(in: directory)
    let (recorded, _) = try XMPParser.parse(
      data: Data(contentsOf: directory.appendingPathComponent("p.xmp")))
    #expect(recorded.crop == Crop(top: 0.125, left: 0.125, bottom: 0.875, right: 0.875))

    let added = try await add(panorama)

    #expect(sent.withLock { $0 } == ["2026/Panoramas/p.png=p.png", "2026/Panoramas/p.xmp=p.xmp"])
    #expect(removed.withLock { $0 }.isEmpty)
    #expect(added.outputURL.path == "/srv/2026/Panoramas/p.png")
    #expect(added.serverAssetID == "asset-1")
    #expect(added.edges == panorama.edges)
  }

  @Test func aPanoramaWithoutACropSidecarUploadsAlone() async throws {
    defer { try? FileManager.default.removeItem(at: directory) }
    let panorama = try PanoTestPanorama.stitched(in: directory, cropped: false)

    let added = try await add(panorama)

    #expect(sent.withLock { $0 } == ["2026/Panoramas/p.png=p.png"])
    #expect(removed.withLock { $0 }.isEmpty)
    #expect(added.storedOnServer)
  }

  @Test func aRefusedSidecarRemovesTheUploadedPanoramaAndFailsTheAdd() async throws {
    defer { try? FileManager.default.removeItem(at: directory) }
    let panorama = try PanoTestPanorama.stitched(in: directory)

    await #expect(throws: PanoFrameDownloadError.uploadRefused("p.xmp")) {
      _ = try await add(panorama, sidecar: { _ in nil })
    }

    #expect(removed.withLock { $0 } == [uploadedPanorama])
  }

  @Test func aSidecarUploadThatThrowsRemovesTheUploadedPanoramaAndSurfacesItsError() async throws {
    defer { try? FileManager.default.removeItem(at: directory) }
    let panorama = try PanoTestPanorama.stitched(in: directory)

    await #expect(throws: ConnectionLost()) {
      _ = try await add(panorama, sidecar: { _ in throw ConnectionLost() })
    }

    #expect(removed.withLock { $0 } == [uploadedPanorama])
  }

  @Test func aPanoramaThatCannotBeRemovedIsReportedAsAddedWithoutItsCrop() async throws {
    defer { try? FileManager.default.removeItem(at: directory) }
    let panorama = try PanoTestPanorama.stitched(in: directory)
    let expected = PanoFrameDownloadError.addedWithoutCrop(
      "p.png", reason: "The server wouldn’t take p.xmp.")

    await #expect(throws: expected) {
      _ = try await add(panorama, sidecar: { _ in nil }, remove: { throw ConnectionLost() })
    }

    #expect(
      expected.errorDescription
        == "p.png is on the server without its Auto Crop (The server wouldn’t take p.xmp.), "
        + "and Maple couldn’t remove it. Merging again adds a second panorama.")
  }

  @Test func stoppingDuringTheSidecarUploadStillRemovesThePanorama() async throws {
    defer { try? FileManager.default.removeItem(at: directory) }
    let panorama = try PanoTestPanorama.stitched(in: directory)
    let removalWasCancelled = OSAllocatedUnfairLock<Bool?>(initialState: nil)
    let adding = Task {
      try await add(
        panorama,
        sidecar: { _ in
          try await Task.sleep(for: .seconds(60))
          return nil
        },
        remove: { removalWasCancelled.withLock { $0 = Task.isCancelled } })
    }
    for _ in 0..<1000 where sent.withLock({ $0.count }) < 2 {
      try await Task.sleep(for: .milliseconds(5))
    }

    adding.cancel()

    await #expect(throws: CancellationError.self) { _ = try await adding.value }
    #expect(removalWasCancelled.withLock { $0 } == false)
    #expect(removed.withLock { $0 } == [uploadedPanorama])
  }
}
