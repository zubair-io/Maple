import Foundation
import XCTest

@testable import MapleCore

#if os(macOS)
  /// Immutable branch queues over the actual Self Hosted API (#4063).
  final class NativeCloudVariantWriterTests: XCTestCase {
    private typealias Fixture = NativeWorkflowControlFixture

    func testFolderAndCatalogBindingsPublishOnlyToTheSelectedNamedBranch() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      for catalog in [false, true] {
        let source = try await fixture.stage(xml: Fixture.input())
        let raw = URL(fileURLWithPath: source.path)
        let original = try Data(contentsOf: raw)
        let primary = SidecarPath.sidecarURL(for: raw)
        let primaryBytes = try Data(contentsOf: primary)
        let id = UUID().uuidString.lowercased()
        let siblings = WorkflowVariantStore(rawURL: raw)
        let path = try await siblings.create(
          SidecarWorkflow(
            schemaVersion: WorkflowContract.version, variantId: id, variantName: "Server branch",
            snapshots: [], history: []))
        let parent = fixture.store(source, catalog: catalog)
        let writer = try await parent.variantWriter(variantId: id)
        let initialDocument = try await writer.readWorkflowXML()
        let initial = try XCTUnwrap(initialDocument)
        let snapshot = WorkflowSnapshot(
          id: UUID().uuidString.lowercased(), name: "Server checkpoint", createdAtMs: 1,
          adjustmentXmp: try WorkflowSidecarCore.checkpoint(xmp: initial))
        let command = WorkflowPublication.snapshot(
          expectedXmp: initial, initialXmp: nil, snapshot: snapshot)
        _ = try await fixture.control("/workflow-fixture/\(source.key)/lose-response", body: [:])
        do {
          _ = try await writer.publishWorkflow(command)
          XCTFail("The accepted snapshot reply was deliberately lost")
        } catch { XCTAssertEqual(try Fixture.record(path).snapshots, [snapshot]) }
        _ = try await writer.publishWorkflow(command)
        XCTAssertEqual(try Fixture.record(path).snapshots, [snapshot])
        var model = AdjustmentModel.default
        model.exposure = 2
        try await writer.commitSemantic(
          model: model, culling: CullingState(stars: 4, keywords: ["Named branch"]),
          action: "adjustment", label: "Exposure")
        await writer.flush()
        XCTAssertEqual(try XMPParser.parse(Fixture.xml(path)).0.exposure, 2)
        let changedDocument = try await writer.readWorkflowXML()
        let changed = try XCTUnwrap(changedDocument)
        _ = try await writer.publishWorkflow(
          .restore(
            expectedXmp: changed,
            entry: WorkflowHistoryEntry(
              id: UUID().uuidString.lowercased(), createdAtMs: 2,
              action: "snapshot-restore", label: "Restore server checkpoint",
              adjustmentXmp: snapshot.adjustmentXmp)))
        XCTAssertEqual(try Fixture.checkpoint(path), snapshot.adjustmentXmp)
        XCTAssertEqual(try Fixture.record(path).variantId, id)
        XCTAssertEqual(try Data(contentsOf: primary), primaryBytes)
        XCTAssertEqual(try Data(contentsOf: raw), original)
        let reopened = try await fixture.store(source, catalog: catalog).variantWriter(
          variantId: id)
        let parsed = try await reopened.load()
        XCTAssertEqual(parsed.0.exposure, 0)
        XCTAssertEqual(parsed.1.keywords, ["Keyword A"])
      }
    }

    func testMissingBranchAndInvalidIdentityDoNotCreateOrAlterAnySidecar() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: Fixture.input())
      let raw = URL(fileURLWithPath: source.path)
      let primary = SidecarPath.sidecarURL(for: raw)
      let initial = try Data(contentsOf: primary)
      let parent = fixture.store(source)
      do {
        _ = try await parent.variantWriter(variantId: UUID().uuidString.lowercased())
        XCTFail("A missing branch cannot fall back to the primary")
      } catch { XCTAssertTrue(error.localizedDescription.contains("missing")) }
      do {
        _ = try await parent.variantWriter(variantId: "../primary")
        XCTFail("An invalid identity cannot select a server path")
      } catch {}
      XCTAssertEqual(try Data(contentsOf: primary), initial)
      let branches = try await WorkflowVariantStore(rawURL: raw).list()
      XCTAssertEqual(branches.map(\.variantId), [WorkflowContract.primaryVariantID])
    }
  }
#endif
