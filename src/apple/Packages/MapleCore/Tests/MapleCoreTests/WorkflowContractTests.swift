import Foundation
import XCTest

@testable import MapleCore

final class WorkflowContractTests: XCTestCase {
  private func corpusData() throws -> Data {
    try Data(contentsOf: WorkflowFixture.root().appendingPathComponent("workflow/contract-v1.json"))
  }
  func testCompleteCheckpointBytesSurviveActualFilesAndReopen() throws {
    let values = try JSONDecoder().decode([SidecarWorkflow].self, from: corpusData())
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    for value in values {
      let file = directory.appendingPathComponent("\(value.variantId).json")
      try encoder.encode(value).write(to: file, options: .atomic)
      XCTAssertEqual(
        try JSONDecoder().decode(SidecarWorkflow.self, from: Data(contentsOf: file)), value)
      for xml in value.snapshots.map(\.adjustmentXmp) + value.history.map(\.adjustmentXmp) {
        let sidecar = directory.appendingPathComponent("checkpoint.xmp")
        try Data(xml.utf8).write(to: sidecar, options: .atomic)
        XCTAssertEqual(try Data(contentsOf: sidecar), Data(xml.utf8))
      }
    }
  }
  func testFixturesResolveFromStagedCIStructureAndFailWhenMissing() throws {
    let stage = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: stage) }
    let root = stage.appendingPathComponent("test-fixtures")
    let committed = try WorkflowFixture.root()
    for relative in WorkflowFixture.required {
      let destination = root.appendingPathComponent(relative)
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try FileManager.default.copyItem(
        at: committed.appendingPathComponent(relative), to: destination)
    }
    let source = stage.appendingPathComponent(
      "Packages/MapleCore/Tests/MapleCoreTests/source.swift")
    XCTAssertEqual(try WorkflowFixture.root(from: source).path, root.path)
    try FileManager.default.removeItem(at: root)
    XCTAssertThrowsError(try WorkflowFixture.root(from: source))
  }
  func testWireDecoderRejectsMalformedRecordsWithoutChangingInput() throws {
    let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: corpusData()) as? [[String: Any]])
    let base = rows[0]
    let history = try XCTUnwrap(base["history"] as? [[String: Any]])
    let snapshots = try XCTUnwrap(base["snapshots"] as? [[String: Any]])
    let invalid: [[String: Any]] = [
      base.merging(["schemaVersion": 2]) { _, new in new },
      base.merging(["future": true]) { _, new in new },
      base.filter { $0.key != "variantName" },
      base.merging(["variantId": "../photo"]) { _, new in new },
      base.merging(["snapshots": [snapshots[0], snapshots[0]]]) { _, new in new },
      base.merging(["history": [history[0], history[0]]]) { _, new in new },
      base.merging(["snapshots": [snapshots[0].merging(["future": true]) { _, new in new }]]) {
        _, new in new
      },
      base.merging(["history": [history[0].merging(["action": "render"]) { _, new in new }]]) {
        _, new in new
      },
      base.merging([
        "history": [
          history[0].merging(["createdAtMs": UInt64(9_007_199_254_740_992)]) { _, new in new }
        ]
      ]) { _, new in new },
      base.merging([
        "snapshots": [
          snapshots[0].merging(["id": "00000000-0000-0000-0000-000000000064\n"]) { _, new in new }
        ]
      ]) { _, new in new },
    ]
    for value in invalid {
      XCTAssertThrowsError(
        try JSONDecoder().decode(
          SidecarWorkflow.self, from: JSONSerialization.data(withJSONObject: value)))
    }
    XCTAssertEqual(try JSONDecoder().decode([SidecarWorkflow].self, from: corpusData()).count, 2)
  }
}

/// Both the checkout and CI's isolated package must include the committed corpus.
enum WorkflowFixture {
  static let required = ["workflow/contract-v1.json", "local-adjustments/lightroom-group-add.xmp"]
  static func root(from file: URL = URL(fileURLWithPath: #filePath)) throws -> URL {
    let parents = sequence(first: file.standardizedFileURL.deletingLastPathComponent()) {
      directory -> URL? in
      let parent = directory.deletingLastPathComponent().standardizedFileURL
      return parent.path == directory.path ? nil : parent
    }
    guard
      let root = parents.lazy.map({ $0.appendingPathComponent("test-fixtures") }).first(where: {
        directory in
        required.allSatisfy {
          FileManager.default.fileExists(atPath: directory.appendingPathComponent($0).path)
        }
      })
    else {
      throw NSError(
        domain: "WorkflowFixture", code: 1,
        userInfo: [
          NSLocalizedDescriptionKey: "Missing committed workflow fixtures above \(file.path)"
        ])
    }
    return root
  }
}
