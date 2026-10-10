import Foundation
import XCTest

@testable import MapleCore

/// Real server publication after integrating #4065 with removal snapshots (#3984).
final class SMBRemovalPublicationTests: XCTestCase {
  func testAdjustmentPublicationsPreserveExistingRemovalAndCannotInjectOne() async throws {
    let saved = try XCTUnwrap(
      Bundle.module.url(
        forResource: "saved", withExtension: "xmp", subdirectory: "removal/calibration"))
    let savedXML = try String(contentsOf: saved, encoding: .utf8)
    let records = try XCTUnwrap(try XMPParser.parse(savedXML).0.inpaintRemovals)
    for existing in [false, true] {
      for semantic in [false, true] {
        let initial = existing ? savedXML : NativeWorkflowControlFixture.input()
        let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self, initialXML: initial)
        do {
          let ref = try await fixture.image()
          let store = SMBSidecarStore(source: fixture.source, ref: ref)
          var incoming = try await store.load().0
          incoming.exposure = 1.5
          incoming.inpaintRemovals = existing ? nil : records
          if semantic {
            try await store.commitSemantic(
              model: incoming, culling: CullingState(), action: "adjustment", label: "Exposure")
          } else {
            try await store.writeConfirmed(model: incoming, culling: CullingState())
          }
          let expected = existing ? records : nil
          let xml = try await store.readWorkflowXML()
          let confirmed = try XCTUnwrap(xml)
          let onDisk = try String(
            contentsOf: fixture.share.appendingPathComponent("photo.xmp"), encoding: .utf8)
          XCTAssertEqual(confirmed, onDisk)
          XCTAssertEqual(try XMPParser.parse(onDisk).0.inpaintRemovals, expected)
          let cached = try await store.load().0
          XCTAssertEqual(cached.inpaintRemovals, expected)
          XCTAssertEqual(cached.exposure, 1.5)
          if semantic {
            let workflow = try XCTUnwrap(WorkflowSidecarCore.read(xmp: confirmed))
            let entry = try XCTUnwrap(workflow.history.last)
            XCTAssertEqual(try XMPParser.parse(entry.adjustmentXmp).0.inpaintRemovals, expected)
          }
          XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
          await fixture.close()
        } catch {
          await fixture.close()
          throw error
        }
      }
    }
  }
}
