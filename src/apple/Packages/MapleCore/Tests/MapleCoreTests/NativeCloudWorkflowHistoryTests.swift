import Foundation
import XCTest

@testable import MapleCore

#if os(macOS)
  @MainActor
  final class NativeCloudWorkflowHistoryTests: EditorTestCase {
    private func input() throws -> String {
      try String(
        contentsOf: WorkflowFixture.root().appending(
          path: "local-adjustments/lightroom-group-add.xmp"), encoding: .utf8)
    }

    private func corpus() throws -> [SidecarWorkflow] {
      try JSONDecoder().decode(
        [SidecarWorkflow].self,
        from: Data(
          contentsOf:
            WorkflowFixture.root().appending(path: "workflow/contract-v1.json")))
    }

    private func xml(_ source: NativeWorkflowHTTPFixture.Source) throws -> String {
      try String(
        contentsOf: SidecarPath.sidecarURL(for: URL(fileURLWithPath: source.path)), encoding: .utf8)
    }

    private func record(_ source: NativeWorkflowHTTPFixture.Source) throws -> SidecarWorkflow {
      try XCTUnwrap(WorkflowSidecarCore.read(xmp: xml(source)))
    }

    private func session(
      _ fixture: NativeWorkflowHTTPFixture, _ source: NativeWorkflowHTTPFixture.Source,
      catalog: Bool = false
    ) -> EditSession {
      let path = source.path
      let asset = AssetRef(
        displayName: "photo.dng", hintExtension: "dng", stableID: source.id,
        bytesProvider: { try Data(contentsOf: URL(fileURLWithPath: path)) })
      return EditSession(asset: asset, remoteSidecarStore: fixture.store(source, catalog: catalog))
    }

    private func rapid(catalog: Bool, existing: Bool) async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: existing ? input() : nil)
      let original = try Data(contentsOf: URL(fileURLWithPath: source.path))
      let editor = session(fixture, source, catalog: catalog)
      await editor.loadSidecar()
      let state = EditorState(session: editor)
      state.arm(tool: .exposure)
      for value in [0.25, 0.75, 1.25] {
        state.commit()
        state.beginGesture()
        state.setArmedDisplayValue(value - 0.1)
        state.setArmedDisplayValue(value)
        state.endGesture()
      }
      state.undo()
      state.redo()
      await editor.flushPendingSidecarWrite()
      XCTAssertNil(editor.sidecarError)
      let workflow = try record(source)
      XCTAssertEqual(
        workflow.history.map(\.action), ["adjustment", "adjustment", "adjustment", "undo", "redo"])
      XCTAssertEqual(
        try workflow.history.map { try XMPParser.parse($0.adjustmentXmp).0.exposure },
        [0.25, 0.75, 1.25, 0.75, 1.25])
      XCTAssertEqual(Set(workflow.history.map(\.id)).count, 5)
      let reopened = session(fixture, source, catalog: catalog)
      await reopened.loadSidecar()
      XCTAssertEqual(reopened.model.exposure, 1.25)
      XCTAssertNil(reopened.sidecarError)
      XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: source.path)), original)
      if existing { XCTAssertTrue(try xml(source).contains("crs:MaskGroupBasedCorrections")) }
    }

    func testActualFolderEditorGesturesUndoRedoAndReopen() async throws {
      try await rapid(catalog: false, existing: true)
    }

    func testActualCatalogEditorCreatesAbsentPrimaryAndReopensHistory() async throws {
      try await rapid(catalog: true, existing: false)
    }

    func testPreviewTicksAndNoopDoNotProduceHistory() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: input())
      let editor = session(fixture, source)
      await editor.loadSidecar()
      editor.model.exposure = 0.25
      editor.model.exposure = 0.5
      editor.beginEdit()
      editor.endEdit()
      await editor.flushPendingSidecarWrite()
      XCTAssertNil(editor.sidecarError)
      XCTAssertNil(try WorkflowSidecarCore.read(xmp: xml(source)))
      XCTAssertEqual(try XMPParser.parse(xml(source)).0.exposure, 0.5)
    }

    func testFailedEditorGestureRemainsFrozenThroughLaterPreviewAndFlush() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: input())
      let original = try Data(contentsOf: URL(fileURLWithPath: source.path))
      let editor = session(fixture, source)
      await editor.loadSidecar()
      _ = try await fixture.control("/workflow-fixture/\(source.key)/obstruct", body: [:])
      editor.beginEdit(description: "Captured exposure")
      editor.model.exposure = 1.25
      editor.endEdit()
      await editor.flushPendingSidecarWrite()
      XCTAssertNotNil(editor.sidecarError)
      _ = try await fixture.control("/workflow-fixture/\(source.key)/repair", body: [:])
      editor.model.exposure = 2.5
      await editor.flushPendingSidecarWrite()
      let workflow = try record(source)
      XCTAssertEqual(workflow.history.count, 1)
      XCTAssertEqual(try XMPParser.parse(workflow.history[0].adjustmentXmp).0.exposure, 1.25)
      XCTAssertEqual(try XMPParser.parse(xml(source)).0.exposure, 2.5)
      XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: source.path)), original)
    }

    func testCompactionPreservesImportedSnapshotsExactly() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let imported = try corpus()[0]
      let source = try await fixture.stage(xml: input(), workflow: imported)
      let store = fixture.store(source)
      let loaded = try await store.load()
      for index in 1...40 {
        var model = loaded.0
        model.exposure = Double(index) / 10
        try await store.commitSemantic(
          model: model, culling: loaded.1, action: "adjustment", label: "Exposure \(index)")
      }
      let workflow = try record(source)
      XCTAssertEqual(workflow.snapshots, imported.snapshots)
      XCTAssertEqual(workflow.history.count, WorkflowContract.historyLimit)
      XCTAssertEqual(
        try workflow.history.map { try XMPParser.parse($0.adjustmentXmp).0.exposure },
        (9...40).map { Double($0) / 10 })
      XCTAssertTrue(try xml(source).contains("crs:MaskGroupBasedCorrections"))
    }

    func testLostAcceptedResponseRetriesTheSameActionWithoutDuplicatingHistory() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: input())
      let store = fixture.store(source)
      let loaded = try await store.load()
      _ = try await fixture.control("/workflow-fixture/\(source.key)/lose-response", body: [:])
      var captured = loaded.0
      captured.exposure = 1.25
      do {
        try await store.commitSemantic(
          model: captured, culling: loaded.1, action: "preset", label: "Lost acknowledgement")
        XCTFail("lost acknowledgement was reported as successful")
      } catch {}
      let accepted = try record(source)
      XCTAssertEqual(accepted.history.count, 1)
      var preview = captured
      preview.exposure = 2.5
      await store.update(model: preview, culling: loaded.1)
      await store.flush()
      XCTAssertEqual(try record(source).history, accepted.history)
      XCTAssertEqual(try XMPParser.parse(xml(source)).0.exposure, 2.5)
    }

    func testUnsupportedAndMismatchedPrimaryRejectWithoutReplacingActualBytes() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let rows = try corpus()
      for (workflow, future) in [(rows[0], true), (rows[1], false)] {
        let source = try await fixture.stage(xml: input(), workflow: workflow, future: future)
        let store = fixture.store(source)
        var model = AdjustmentModel.default
        model.exposure = 1.25
        do {
          try await store.commitSemantic(
            model: model, culling: CullingState(), action: "preset", label: "Rejected preset")
          XCTFail("unsupported primary was accepted")
        } catch {}
        XCTAssertEqual(try xml(source), source.input)
      }
    }

    func testActualFolderAndCatalogHydrationRejectInvalidPrimaryThenLoadRepairedSource()
      async throws
    {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let rows = try corpus()
      let valid = try input()
      for catalog in [false, true] {
        for (workflow, future) in [(rows[0], true), (rows[1], false)] {
          let source = try await fixture.stage(xml: valid, workflow: workflow, future: future)
          let original = try Data(contentsOf: URL(fileURLWithPath: source.path))
          let store = fixture.store(source, catalog: catalog)
          do {
            _ = try await store.loadIfPresent()
            XCTFail("Native API hydration accepted an invalid primary workflow")
          } catch {}
          XCTAssertEqual(try xml(source), source.input)
          try Data(valid.utf8).write(
            to: SidecarPath.sidecarURL(for: URL(fileURLWithPath: source.path)), options: .atomic)
          let repaired = try await store.loadIfPresent()
          XCTAssertEqual(repaired?.0, try XMPParser.parse(valid).0)
          XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: source.path)), original)
        }
      }
    }

    func testIndependentAuthenticatedWritersRetainEveryCaptureAfterConfirmedConflict() async throws
    {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: input())
      let stores = (0..<8).map { _ in fixture.store(source) }
      let loaded = try await stores[0].load()
      _ = try await fixture.control("/workflow-fixture/\(source.key)/race", body: [:])
      let outcomes = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
        for (index, store) in stores.enumerated() {
          var model = loaded.0
          model.exposure = Double(index + 1) / 10
          let captured = model
          group.addTask {
            do {
              try await store.commitSemantic(
                model: captured, culling: loaded.1, action: "preset", label: "Client \(index)")
              return true
            } catch { return false }
          }
        }
        var results: [Bool] = []
        for await result in group { results.append(result) }
        return results
      }
      _ = try await fixture.control("/workflow-fixture/\(source.key)/end-race", body: [:])
      XCTAssertEqual(outcomes.filter { $0 }.count, 1)
      XCTAssertEqual(try record(source).history.count, 1)
      for _ in 0..<8 {
        for store in stores { await store.flush() }
        if try record(source).history.count == 8 { break }
      }
      let workflow = try record(source)
      XCTAssertEqual(Set(workflow.history.map(\.id)).count, 8)
      XCTAssertEqual(
        try workflow.history.map { try XMPParser.parse($0.adjustmentXmp).0.exposure }.sorted(),
        (1...8).map { Double($0) / 10 })
    }
  }
#endif
