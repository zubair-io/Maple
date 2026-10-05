import CoreImage
import Foundation
import ImageIO
import MapleAgentWire
import XCTest

@testable import MapleCore

@MainActor
final class AgentExportTests: XCTestCase {
  private func sourceBytes() throws -> Data {
    let image = CIImage(color: CIColor(red: 0.2, green: 0.4, blue: 0.6))
      .cropped(to: CGRect(x: 0, y: 0, width: 48, height: 32))
    return try MapleExporter.encode(image, options: ExportOptions(format: .png))
  }

  private func call(_ service: AgentEditService, revision: String?) async -> AgentResponse {
    await service.handle(
      AgentRequest(
        id: 1, tool: "maple_export_photo",
        arguments: revision.map { ["expected_revision": .string($0)] } ?? [:]))
  }

  func testDefaultExportUsesEditsAndFullSizeWithoutChangingOriginalOrSidecar() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-export")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("source.png")
    let originalBytes = try sourceBytes()
    try originalBytes.write(to: original)
    let session = EditSession(asset: AssetRef(url: original), model: .default)
    let baseline = try await MapleExporter.exportData(session: session, options: .defaults)
    session.beginEdit(description: "Brighter")
    session.model.exposure = 0.75
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let sidecarBytes = try Data(contentsOf: sidecar)
    let expected = try await MapleExporter.exportData(session: session, options: .defaults)
    let exports = root.appendingPathComponent("Exports")
    let service = AgentEditService(exportDirectory: exports)
    service.activate(session)
    let revision = AgentEditService.revision(of: session)
    let result = try await call(service, revision: revision).outcome.get().result
    let url = URL(fileURLWithPath: try XCTUnwrap(result["path"]?.stringValue))
    let bytes = try Data(contentsOf: url)
    XCTAssertEqual(url.deletingLastPathComponent().path, exports.path)
    XCTAssertEqual(url.pathExtension, "jpg")
    XCTAssertEqual(result["format"], "jpeg_srgb")
    XCTAssertEqual(result["byte_count"], .int(bytes.count))
    XCTAssertEqual(result["photo_id"], .string(session.asset.id.uuidString))
    XCTAssertEqual(result["revision"], .string(revision))
    XCTAssertEqual(bytes, expected, "The MCP export must use the panel's actual defaults")
    XCTAssertNotEqual(bytes, baseline, "The export must include the live exposure edit")
    let decoded = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
    XCTAssertEqual(CGImageSourceGetType(decoded) as String?, "public.jpeg")
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(decoded, 0, nil))
    XCTAssertEqual(image.width, 48)
    XCTAssertEqual(image.height, 32)
    XCTAssertEqual(image.colorSpace?.name, CGColorSpace.sRGB)
    let again = try await call(service, revision: revision).outcome.get().result
    XCTAssertNotEqual(again["path"], result["path"], "Repeated calls must never replace an export")
    XCTAssertEqual(try Data(contentsOf: url), bytes)
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
    XCTAssertEqual(try Data(contentsOf: sidecar), sidecarBytes)
    XCTAssertEqual(session.undoHistory.count, 1, "Export is not an edit")
  }

  func testMissingPhotoAndMissingOrStaleRevisionCannotExport() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-export-invalid")
    defer { try? FileManager.default.removeItem(at: root) }
    let exports = root.appendingPathComponent("Exports")
    let service = AgentEditService(exportDirectory: exports)
    let absent = await call(service, revision: "any")
    XCTAssertEqual(absent.outcome.failureCode, "no_active_photo")
    let bytes = try sourceBytes()
    let session = EditSession(
      asset: AssetRef(displayName: "source.png", hintExtension: "png") { bytes }, model: .default)
    service.activate(session)
    let missing = await call(service, revision: nil)
    XCTAssertEqual(missing.outcome.failureCode, "invalid_arguments")
    let stale = await call(service, revision: "old")
    XCTAssertEqual(stale.outcome.failureCode, "stale_revision")
    let extra = await service.handle(
      AgentRequest(
        id: 2, tool: "maple_export_photo",
        arguments: [
          "expected_revision": .string(AgentEditService.revision(of: session)),
          "destination": .string("/should-not-be-written.jpg"),
        ]))
    XCTAssertEqual(extra.outcome.failureCode, "invalid_arguments")
    session.workflow.isBusy = true
    let busy = await call(service, revision: AgentEditService.revision(of: session))
    XCTAssertEqual(busy.outcome.failureCode, "busy")
    session.workflow.isBusy = false
    XCTAssertFalse(FileManager.default.fileExists(atPath: exports.path))
  }

  func testPhotoSwitchDuringExportDoesNotPublish() async throws {
    let replacement = EditSession(asset: AssetRef(url: URL(fileURLWithPath: "/next.dng")))
    try await exportWhileChanging { service, _ in
      service.activate(replacement)
    }
  }

  func testManualEditDuringExportDoesNotPublish() async throws {
    try await exportWhileChanging { _, session in
      session.beginEdit(description: "Manual exposure")
      session.model.exposure = 1
      session.endEdit()
    }
  }

  func testCancellationDuringExportDoesNotPublish() async throws {
    try await exportWhileChanging(cancel: true) { _, _ in }
  }

  func testCancellationAfterStagingDoesNotPublishAndRemovesTemporaryFile() async throws {
    try await exportAtPublicationBoundary(cancel: true)
  }

  func testRevisionChangeAfterStagingDoesNotPublishAndRemovesTemporaryFile() async throws {
    try await exportAtPublicationBoundary(cancel: false)
  }

  private func exportAtPublicationBoundary(cancel: Bool) async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-export-publication")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("source.png")
    let bytes = try sourceBytes()
    try bytes.write(to: original)
    let session = EditSession(asset: AssetRef(url: original), model: .default)
    let revision = AgentEditService.revision(of: session)
    let exports = root.appendingPathComponent("Exports")
    try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
    let existing = exports.appendingPathComponent("existing.jpg")
    let marker = Data("previous export".utf8)
    try marker.write(to: existing)

    let pending = Task {
      try await AgentPhotoExporter.export(
        session: session, revision: revision, directory: exports
      ) {
        let files = try FileManager.default.contentsOfDirectory(
          at: exports, includingPropertiesForKeys: nil)
        if files.count == 1 {
          XCTAssertEqual(files.first?.lastPathComponent, "existing.jpg")
          return
        }
        let staged = try XCTUnwrap(files.first { $0.pathExtension == "tmp" })
        XCTAssertEqual(files.count, 2, "The completed JPEG must still be unpublished")
        let jpeg = try Data(contentsOf: staged)
        let decoded = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(decoded) as String?, "public.jpeg")
        if cancel {
          withUnsafeCurrentTask { $0?.cancel() }
        } else {
          session.beginEdit(description: "Changed while staging")
          session.model.exposure = 1
          session.endEdit()
          guard AgentEditService.revision(of: session) == revision else {
            throw AgentError(code: "stale_revision", message: "The photo changed during export.")
          }
          XCTFail("The edit must invalidate the exported revision")
        }
      }
    }
    do {
      _ = try await pending.value
      XCTFail("A cancelled or superseded staged export must not publish")
    } catch is CancellationError {
      XCTAssertTrue(cancel)
    } catch let error as AgentError {
      XCTAssertFalse(cancel)
      XCTAssertEqual(error.code, "stale_revision")
    }
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: exports.path), ["existing.jpg"])
    XCTAssertEqual(try Data(contentsOf: existing), marker)
    XCTAssertEqual(try Data(contentsOf: original), bytes)
    await session.flushPendingSidecarWrite()
  }

  func testUnwritableExportLocationReportsFailureWithoutReplacingTheFile() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-export-write-error")
    defer { try? FileManager.default.removeItem(at: root) }
    let existingFile = root.appendingPathComponent("Exports")
    let marker = Data("existing file".utf8)
    try marker.write(to: existingFile)
    let bytes = try sourceBytes()
    let session = EditSession(
      asset: AssetRef(displayName: "source.png", hintExtension: "png") { bytes })
    let service = AgentEditService(exportDirectory: existingFile)
    service.activate(session)
    let response = await call(service, revision: AgentEditService.revision(of: session))
    guard case .failure = response.outcome else { return XCTFail("Expected a write failure") }
    XCTAssertEqual(try Data(contentsOf: existingFile), marker)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["Exports"])
  }

  private func exportWhileChanging(
    cancel: Bool = false, change: (AgentEditService, EditSession) -> Void
  ) async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-export-fenced")
    defer { try? FileManager.default.removeItem(at: root) }
    let exports = root.appendingPathComponent("Exports")
    let started = expectation(description: "Actual export decode requested bytes")
    let source = ExportSourceGate(bytes: try sourceBytes(), started: started)
    let session = EditSession(
      asset: AssetRef(displayName: "source.png", hintExtension: "png") { await source.read() })
    let service = AgentEditService(exportDirectory: exports)
    service.activate(session)
    let revision = AgentEditService.revision(of: session)
    let pending = Task { await call(service, revision: revision) }
    await fulfillment(of: [started], timeout: 10)
    change(service, session)
    if cancel { pending.cancel() }
    await source.release()
    let response = await pending.value
    guard case .failure(let error) = response.outcome else {
      return XCTFail("Export published after the session changed or the request was cancelled")
    }
    if !cancel { XCTAssertEqual(error.code, "stale_revision") }
    XCTAssertFalse(FileManager.default.fileExists(atPath: exports.path))
  }
}

extension Result where Success == AgentPayload, Failure == AgentError {
  fileprivate var failureCode: String? {
    if case .failure(let error) = self { return error.code }
    return nil
  }
}

private actor ExportSourceGate {
  let bytes: Data
  let started: XCTestExpectation
  var released = false
  var waiting: CheckedContinuation<Void, Never>?

  init(bytes: Data, started: XCTestExpectation) {
    self.bytes = bytes
    self.started = started
  }

  func read() async -> Data {
    if !released {
      await withCheckedContinuation { continuation in
        waiting = continuation
        started.fulfill()
      }
    }
    return bytes
  }

  func release() {
    released = true
    waiting?.resume()
    waiting = nil
  }
}
