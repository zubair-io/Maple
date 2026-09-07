#if os(iOS)
  import UIKit
  import XCTest

  @testable import Maple_Exposure

  @MainActor
  final class EditorTextInputTests: XCTestCase {
    func testFirstResponderSearchStopsBeforeLaterSiblingTrees() {
      let root = ResponderProbeView()
      let firstBranch = ResponderProbeView()
      let responder = ResponderProbeView(responds: true)
      let laterBranch = ResponderProbeView()
      let laterChild = ResponderProbeView()
      root.addSubview(firstBranch)
      firstBranch.addSubview(responder)
      root.addSubview(laterBranch)
      laterBranch.addSubview(laterChild)
      for view in [root, firstBranch, responder, laterBranch, laterChild] {
        view.reads = 0
      }

      XCTAssertTrue(EditorTextInput.findResponder(root) === responder)
      XCTAssertEqual(root.reads, 1)
      XCTAssertEqual(firstBranch.reads, 1)
      XCTAssertEqual(responder.reads, 1)
      XCTAssertEqual(laterBranch.reads, 0)
      XCTAssertEqual(laterChild.reads, 0)
    }

    func testFirstResponderParentDoesNotSearchItsChildren() {
      let responder = ResponderProbeView(responds: true)
      let child = ResponderProbeView()
      responder.addSubview(child)
      for view in [responder, child] { view.reads = 0 }
      XCTAssertTrue(EditorTextInput.findResponder(responder) === responder)
      XCTAssertEqual(responder.reads, 1)
      XCTAssertEqual(child.reads, 0)
    }

    func testNoResponderReturnsNilAfterSearchingAllBranches() {
      let root = ResponderProbeView()
      let first = ResponderProbeView()
      let last = ResponderProbeView()
      root.addSubview(first)
      root.addSubview(last)
      for view in [root, first, last] { view.reads = 0 }
      XCTAssertNil(EditorTextInput.findResponder(root))
      XCTAssertEqual(root.reads, 1)
      XCTAssertEqual(first.reads, 1)
      XCTAssertEqual(last.reads, 1)
    }
  }

  @MainActor
  private final class ResponderProbeView: UIView {
    let responds: Bool
    var reads = 0

    init(responds: Bool = false) {
      self.responds = responds
      super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { return nil }

    override var isFirstResponder: Bool {
      reads += 1
      return responds
    }
  }
#endif
