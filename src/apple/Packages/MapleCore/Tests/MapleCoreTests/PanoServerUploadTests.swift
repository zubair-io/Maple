// PanoServerUploadTests.swift — the crop sidecar travels with an on-device
// panorama added to the server (#5608).

import Foundation
import Testing
import os

@testable import MapleCore

@Suite struct PanoServerUploadTests {
  @Test func theCropSidecarIsUploadedAfterThePanoramaBesideIt() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "upload-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let png = directory.appendingPathComponent("p.png")
    try Data([1]).write(to: png)
    try Data([2]).write(to: directory.appendingPathComponent("p.xmp"))
    let result = PanoResult(outputURL: png, reportSummary: "")
    let sent = OSAllocatedUnfairLock<[String]>(initialState: [])

    let added = try await PanoServerUpload.add(result, target: "2026/Panoramas/p.png") { path, file in
      sent.withLock { $0.append("\(path)=\(file.lastPathComponent)") }
      return ("/srv/\(path)", "asset")
    }

    #expect(sent.withLock { $0 } == ["2026/Panoramas/p.png=p.png", "2026/Panoramas/p.xmp=p.xmp"])
    #expect(added.outputURL.path == "/srv/2026/Panoramas/p.png")
  }

  @Test func aPanoramaWithoutACropSidecarUploadsAlone() async throws {
    let png = FileManager.default.temporaryDirectory.appendingPathComponent(
      "alone-\(UUID().uuidString).png")
    try Data([1]).write(to: png)
    defer { try? FileManager.default.removeItem(at: png) }
    let sent = OSAllocatedUnfairLock<Int>(initialState: 0)

    _ = try await PanoServerUpload.add(
      PanoResult(outputURL: png, reportSummary: ""), target: "Panoramas/a.png"
    ) { path, _ in
      sent.withLock { $0 += 1 }
      return (path, nil)
    }

    #expect(sent.withLock { $0 } == 1)
  }

  @Test func aRefusedSidecarFailsTheAdd() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "refused-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let png = directory.appendingPathComponent("p.png")
    try Data([1]).write(to: png)
    try Data([2]).write(to: directory.appendingPathComponent("p.xmp"))

    await #expect(throws: PanoFrameDownloadError.self) {
      _ = try await PanoServerUpload.add(
        PanoResult(outputURL: png, reportSummary: ""), target: "Panoramas/p.png"
      ) { path, _ in path.hasSuffix(".xmp") ? nil : (path, nil) }
    }
  }
}
