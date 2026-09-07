// FolderMoveVMTests.swift — the "Move Folder to…" loading state
// (`Maple/Views/FolderMove/FolderMove+VM.swift`, PR #3429 follow-up): the
// spinner phase appears the instant the user asks, a second ask while a
// walk is in flight is ignored, a cancelled walk's late result is dropped,
// and a failed walk goes back to idle and reports its error. The loader is
// injected and held open on a continuation so each test controls exactly
// when the "walk" finishes.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

@MainActor
final class FolderMoveVMTests: XCTestCase {

  /// A loader the test resumes by hand.
  private final class LoaderGate {
    private var continuation: CheckedContinuation<[FolderMoveDestination], Error>?
    private(set) var calls = 0

    var isWaiting: Bool { continuation != nil }

    func wait() async throws -> [FolderMoveDestination] {
      calls += 1
      return try await withCheckedThrowingContinuation { continuation = $0 }
    }

    func resume(with nodes: [FolderMoveDestination]) {
      continuation?.resume(returning: nodes)
      continuation = nil
    }

    func fail(_ error: Error) {
      continuation?.resume(throwing: error)
      continuation = nil
    }
  }

  private struct WalkFailed: Error {}

  private let target = FolderMovePrompt.Target.local(
    folderURL: URL(fileURLWithPath: "/Library/Trips/Iceland"), rootBookmark: Data([1, 2, 3]))

  private let nodes = [
    FolderMoveDestination(id: "/Library", parentID: nil, name: "Library", depth: 0, hasChildren: true),
    FolderMoveDestination(
      id: "/Library/Trips", parentID: "/Library", name: "Trips", depth: 1, hasChildren: false),
  ]

  /// Let the VM's main-actor task run until `condition` holds (bounded).
  private func settle(until condition: @MainActor () -> Bool) async {
    for _ in 0..<200 where !condition() {
      await Task.yield()
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
  }

  func testBeginShowsThePreparingStateImmediatelyThenTheReadyPrompt() async {
    let vm = FolderMoveVM()
    let gate = LoaderGate()

    XCTAssertTrue(vm.begin(target) { try await gate.wait() })

    XCTAssertTrue(vm.isPreparing, "the spinner phase must not wait for the walk")
    XCTAssertNil(vm.prompt)
    await settle { gate.isWaiting }
    XCTAssertEqual(gate.calls, 1)

    gate.resume(with: nodes)
    await settle { vm.prompt != nil }

    XCTAssertFalse(vm.isPreparing)
    XCTAssertEqual(vm.prompt?.nodes, nodes)
    guard case .local(let url, let bookmark)? = vm.prompt?.target else {
      return XCTFail("prompt should carry the target it was begun with")
    }
    XCTAssertEqual(url.path, "/Library/Trips/Iceland")
    XCTAssertEqual(bookmark, Data([1, 2, 3]))
  }

  func testASecondBeginWhilePreparingIsIgnored() async {
    let vm = FolderMoveVM()
    let gate = LoaderGate()
    vm.begin(target) { try await gate.wait() }
    await settle { gate.isWaiting }

    let second = LoaderGate()
    XCTAssertFalse(vm.begin(target) { try await second.wait() })

    XCTAssertEqual(second.calls, 0, "a double-tap must not start a second walk")
    XCTAssertTrue(vm.isPreparing)
    gate.resume(with: nodes)
    await settle { vm.prompt != nil }
    XCTAssertEqual(gate.calls, 1)
  }

  func testBeginWhileThePickerIsUpIsIgnored() async {
    let vm = FolderMoveVM()
    let gate = LoaderGate()
    vm.begin(target) { try await gate.wait() }
    await settle { gate.isWaiting }
    gate.resume(with: nodes)
    await settle { vm.prompt != nil }

    XCTAssertFalse(vm.begin(target) { [] })
    XCTAssertNotNil(vm.prompt)
  }

  func testCancelWhilePreparingDropsTheLateResult() async {
    let vm = FolderMoveVM()
    let gate = LoaderGate()
    vm.begin(target) { try await gate.wait() }
    await settle { gate.isWaiting }

    vm.cancel()

    XCTAssertFalse(vm.isPreparing, "dismissing the sheet resets synchronously")
    gate.resume(with: nodes)
    await settle { false }
    XCTAssertNil(vm.prompt, "a walk that finishes after Cancel must not resurrect the picker")
    XCTAssertFalse(vm.isPreparing)
  }

  func testCancelWhilePreparingCancelsTheLoaderTask() async {
    let vm = FolderMoveVM()
    var observedCancellation = false
    vm.begin(target) {
      await withTaskCancellationHandler {
        // Park until cancelled; the handler flips the flag.
        while !Task.isCancelled { await Task.yield() }
        return []
      } onCancel: {
        observedCancellation = true
      }
    }

    vm.cancel()
    await settle { observedCancellation }

    XCTAssertTrue(observedCancellation, "Cancel must propagate to the walk so it stops early")
    XCTAssertNil(vm.prompt)
  }

  func testAFailedWalkReturnsToIdleAndReportsTheError() async {
    let vm = FolderMoveVM()
    let gate = LoaderGate()
    var reported: Error?
    vm.begin(target, load: { try await gate.wait() }, onFailure: { reported = $0 })
    await settle { gate.isWaiting }

    gate.fail(WalkFailed())
    await settle { reported != nil }

    XCTAssertTrue(reported is WalkFailed)
    XCTAssertFalse(vm.isPreparing)
    XCTAssertNil(vm.prompt)
    XCTAssertTrue(vm.begin(target) { [] }, "idle again — the next ask must go through")
  }

  func testFinishHandsBackThePromptAndCloses() async {
    let vm = FolderMoveVM()
    XCTAssertNil(vm.finish(), "nothing to finish while idle")
    vm.begin(target) { self.nodes }
    await settle { vm.prompt != nil }

    let finished = vm.finish()

    XCTAssertEqual(finished?.nodes, nodes)
    XCTAssertNil(vm.prompt)
    XCTAssertFalse(vm.isPreparing)
  }

  func testCancelWhileThePickerIsUpCloses() async {
    let vm = FolderMoveVM()
    vm.begin(target) { self.nodes }
    await settle { vm.prompt != nil }

    vm.cancel()

    XCTAssertNil(vm.prompt)
    XCTAssertTrue(vm.begin(target) { [] })
  }
}
