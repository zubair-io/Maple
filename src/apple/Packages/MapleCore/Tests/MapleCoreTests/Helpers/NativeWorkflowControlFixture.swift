import Foundation
import XCTest

@testable import MapleCore

enum NativeWorkflowControlFixture {
  static func files() throws -> (directory: URL, raw: URL, original: Data) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "workflow-controls")
    var apple = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { apple.deleteLastPathComponent() }
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(
      at: apple.appending(path: "MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"), to: raw)
    return (directory, raw, try Data(contentsOf: raw))
  }

  static func input(exposure: Double = 0, tag: String = "A") -> String {
    var model = AdjustmentModel.default
    model.exposure = exposure
    var metadata = XmpMetadata()
    metadata.caption = "Caption \(tag)"
    let culling = CullingState(
      stars: tag == "A" ? 1 : 5, flag: tag == "A" ? .none : .pick,
      keywords: ["Keyword \(tag)"], colorLabel: tag == "A" ? nil : .blue)
    return XMPSerializer.serialize(model: model, culling: culling, metadata: metadata)
      .replacingOccurrences(
        of: "</rdf:Description>",
        with:
          "<foreign:Audit xmlns:foreign=\"urn:maple:test\" z=\"\(tag)\" a=\"retained\"> \(tag) &amp; unchanged </foreign:Audit>\n  </rdf:Description>"
      )
  }

  static func xml(_ path: URL) throws -> String { try String(contentsOf: path, encoding: .utf8) }
  static func record(_ path: URL) throws -> SidecarWorkflow {
    try XCTUnwrap(WorkflowSidecarCore.read(xmp: xml(path)))
  }
  static func checkpoint(_ path: URL) throws -> String {
    try WorkflowSidecarCore.checkpoint(xmp: xml(path))
  }

  @MainActor
  static func save(_ session: EditSession) async throws -> WorkflowSnapshot {
    await session.workflow.reload(session: session)
    XCTAssertNil(session.workflow.errorText)
    await session.workflow.saveSnapshot(name: "Saved A", session: session)
    XCTAssertNil(session.workflow.errorText)
    return try XCTUnwrap(session.workflow.record?.snapshots.first)
  }

  @MainActor
  static func replace(_ path: URL, session: EditSession, exposure: Double = 1.5, tag: String = "B")
    async throws
  {
    let record = try record(path)
    let changed = try WorkflowSidecarCore.embed(record, in: input(exposure: exposure, tag: tag))
    try Data(changed.utf8).write(to: path, options: .atomic)
    let parsed = try XMPParser.parse(changed)
    session.model = parsed.0
    session.culling = parsed.1
    await session.flushPendingSidecarWrite()
    await session.workflow.reload(session: session)
    XCTAssertNil(session.workflow.errorText)
  }

  @MainActor
  static func fullFlow(_ session: EditSession, path: URL) async throws {
    let snapshot = try await save(session)
    try await replace(path, session: session)
    let before = try checkpoint(path)
    session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
    session.workflow.cancelRestore()
    XCTAssertEqual(try checkpoint(path), before)
    session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
    await session.workflow.confirmRestore(session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(try checkpoint(path), snapshot.adjustmentXmp)
    XCTAssertEqual(session.model.exposure, 0)
    XCTAssertEqual(session.culling, try XMPParser.parse(snapshot.adjustmentXmp).1)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.undoHistory.last?.kind, .variant)
    XCTAssertNil(session.undoHistory.last?.serialized()["checkpoint"])
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(try checkpoint(path), before)
    XCTAssertEqual(session.culling.keywords, ["Keyword B"])
    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try checkpoint(path), snapshot.adjustmentXmp)
    XCTAssertEqual(try record(path).history.map(\.action), ["snapshot-restore", "undo", "redo"])
    session.beginEdit(description: "Later exposure")
    session.model.exposure = 2
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let later = try checkpoint(path)
    XCTAssertEqual(XMPParser.parseMetadata(later).caption, "Caption A")
    XCTAssertTrue(later.contains("z=\"A\""))
    XCTAssertFalse(later.contains("z=\"B\""))
    XCTAssertEqual(session.culling.keywords, ["Keyword A"])
  }
}
