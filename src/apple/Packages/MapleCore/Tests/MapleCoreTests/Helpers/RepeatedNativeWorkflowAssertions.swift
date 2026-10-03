import CoreImage
import Foundation
import XCTest

@testable import MapleCore

/// #4091: consecutive commits against one durable sidecar, not fresh fixtures per iteration.
@MainActor
enum RepeatedNativeWorkflowAssertions {
  static func qualify(
    initial: EditSession, adapter: String,
    reopen: () async throws -> EditSession,
    readXML: () async throws -> String,
    verifyOriginal: () async throws -> Void
  ) async throws {
    let initialXML = try await readXML()
    let caption = XMPParser.parseMetadata(initialXML).caption
    let foreign = try XCTUnwrap(
      initialXML.range(
        of: #"<foreign:Audit\b[^>]*>.*?</foreign:Audit>"#,
        options: .regularExpression
      ).map { String(initialXML[$0]) })
    let culling = initial.culling
    var session = initial
    var executed = 0
    for cycle in 0..<100 {
      let label = "\(adapter) cycle \(cycle + 1)/100"
      let before = session.model
      let beforePixels = try await pixels(session)
      let historyCount = session.undoHistory.count
      session.beginEdit(description: label)
      // Alternate actual slider commits so every cycle has a visible, non-noop change.
      session.model.exposure = cycle.isMultiple(of: 2) ? -0.75 : 0.75
      session.endEdit()
      let applied = session.model
      XCTAssertNotEqual(applied, before, label)
      XCTAssertEqual(session.undoHistory.count, historyCount + 1, label)
      XCTAssertEqual(session.undoHistory.last?.kind, .adjustment, label)
      XCTAssertEqual(session.undoHistory.last?.before, before, label)
      XCTAssertEqual(session.undoHistory.last?.after, applied, label)
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.sidecarError, label)
      let expected = try await pixels(session)
      XCTAssertNotEqual(expected, beforePixels, label)
      try await verifyDocument(
        applied, culling: culling, caption: caption,
        foreign: foreign, readXML: readXML, label: label)

      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.sidecarError, label)
      XCTAssertEqual(session.model, before, label)
      try await verifyDocument(
        before, culling: culling, caption: caption,
        foreign: foreign, readXML: readXML, label: label + " Undo")
      let undone = try await pixels(session)
      XCTAssertEqual(undone, beforePixels, label)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.sidecarError, label)
      XCTAssertEqual(session.model, applied, label)
      let redone = try await pixels(session)
      XCTAssertEqual(redone, expected, label)
      try await verifyDocument(
        applied, culling: culling, caption: caption,
        foreign: foreign, readXML: readXML, label: label + " Redo")
      await release(session)

      let reloaded = try await reopen()
      let canonical = try XMPParser.parse(
        XMPSerializer.serialize(model: applied, culling: culling)
      ).0
      XCTAssertEqual(reloaded.model, canonical, label)
      XCTAssertEqual(reloaded.culling, culling, label)
      XCTAssertTrue(reloaded.undoHistory.isEmpty, label)
      let exported = try await pixels(reloaded)
      XCTAssertEqual(exported, expected, label)
      try await verifyOriginal()
      session = reloaded
      executed += 1
    }
    await release(session)
    XCTAssertEqual(executed, 100, adapter)
    print("qualification: adapter=\(adapter) executed=\(executed) expected=100")
  }

  private static func verifyDocument(
    _ model: AdjustmentModel, culling: CullingState, caption: String?, foreign: String,
    readXML: () async throws -> String, label: String
  ) async throws {
    let xml = try await readXML()
    let parsed = try XMPParser.parse(xml)
    let canonical = try XMPParser.parse(
      XMPSerializer.serialize(model: model, culling: culling)
    ).0
    XCTAssertEqual(parsed.0, canonical, label)
    XCTAssertEqual(parsed.1, culling, label)
    XCTAssertEqual(XMPParser.parseMetadata(xml).caption, caption, label)
    XCTAssertTrue(xml.contains(foreign), label)
  }

  private static func pixels(_ session: EditSession) async throws -> [UInt8] {
    let image = try await session.renderForExport()
    let width = Int(image.extent.width)
    let height = Int(image.extent.height)
    var output = [UInt8](repeating: 0, count: width * height * 4)
    output.withUnsafeMutableBytes {
      CIContext(options: [.cacheIntermediates: false]).render(
        image, toBitmap: $0.baseAddress!, rowBytes: width * 4,
        bounds: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    return output
  }

  private static func release(_ session: EditSession) async {
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    await session.flushPendingSidecarWrite()
    await session.renderActor.cancelAll()
    await session.releaseTransientMemory()
  }
}
