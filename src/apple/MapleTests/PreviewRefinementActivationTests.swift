#if os(iOS)
  import MapleCore
  import UIKit
  import XCTest

  @testable import Maple

  /// #5432: only a page with refinement active ever asks for its display
  /// tier. Programmatic navigation used to swap pages without activating the
  /// new one, and a single failed fetch stopped every later attempt.
  @MainActor
  final class PreviewRefinementActivationTests: XCTestCase {
    func testProgrammaticNavigationActivatesTheNewPageAndDeactivatesTheOld() throws {
      let assets = (0..<4).map { makeCloudRef(index: $0) }
      let coordinator = makeCoordinator(assets: assets)
      let pager = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)

      coordinator.show(assets[0].id, in: pager)
      let first = try XCTUnwrap(coordinator.controller(for: assets[0].id))
      XCTAssertTrue(first.isRefinementActive)

      coordinator.show(assets[1].id, in: pager)
      let second = try XCTUnwrap(coordinator.controller(for: assets[1].id))
      XCTAssertIdentical(pager.viewControllers?.first, second)
      XCTAssertTrue(second.isRefinementActive, "a rail/arrow jump must ask for the larger image")
      XCTAssertFalse(first.isRefinementActive, "the page left behind must stop refining")
    }

    func testRebuiltPageWindowActivatesTheReplacementPage() throws {
      let assets = (0..<3).map { makeCloudRef(index: $0) }
      let coordinator = makeCoordinator(assets: assets)
      let pager = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
      coordinator.show(assets[1].id, in: pager)
      let before = try XCTUnwrap(coordinator.controller(for: assets[1].id))

      // A grown asset list rebuilds every page controller.
      configure(coordinator, assets: assets + [makeCloudRef(index: 3)])
      coordinator.show(assets[1].id, in: pager)
      let after = try XCTUnwrap(coordinator.controller(for: assets[1].id))

      XCTAssertNotIdentical(before, after)
      XCTAssertTrue(after.isRefinementActive)
      XCTAssertFalse(before.isRefinementActive)
    }

    func testShowingTheVisiblePageAgainLeavesItsStateAlone() throws {
      let assets = (0..<3).map { makeCloudRef(index: $0) }
      let coordinator = makeCoordinator(assets: assets)
      let pager = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
      coordinator.show(assets[0].id, in: pager)
      let page = try XCTUnwrap(coordinator.controller(for: assets[0].id))
      // Mid-swipe, `willTransitionTo` deactivates the page being left; a
      // SwiftUI update in that window must not re-arm it.
      page.setRefinementActive(false)
      coordinator.show(assets[0].id, in: pager)
      XCTAssertFalse(page.isRefinementActive)
    }

    func testFailedDisplayFetchIsRetriedUntilItLands() async throws {
      let script = OutcomeScript([
        .indexing(retryAfter: 0),
        .data(try encodedImage(size: 48)),
      ])
      let ref = makeCloudRef(index: 0, script: script)
      let controller = PreviewZoomController(
        assetID: ref.id, seedKey: ref.stableID ?? "", source: .local(ref, source: nil),
        provider: .local())
      // Active before the view loads, as the pager does, so every display
      // fetch is the refinement's own (the thumbnail fallback defers to it).
      controller.setRefinementActive(true)
      let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
      window.rootViewController = controller
      window.isHidden = false
      defer { window.isHidden = true }
      let scroll = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UIScrollView }.first)
      let image = try XCTUnwrap(scroll.subviews.compactMap { $0 as? UIImageView }.first)

      let deadline = ContinuousClock.now.advanced(by: .seconds(8))
      while image.image?.cgImage?.width != 48, ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(20))
      }
      XCTAssertEqual(image.image?.cgImage?.width, 48, "the 202 must be retried, not final")
      let calls = await script.calls
      XCTAssertEqual(calls, 2)
    }

    // MARK: Fixtures

    private func makeCoordinator(assets: [AssetRef]) -> PreviewPager.Coordinator {
      let coordinator = PreviewPager.Coordinator()
      configure(coordinator, assets: assets)
      return coordinator
    }

    private func configure(_ coordinator: PreviewPager.Coordinator, assets: [AssetRef]) {
      coordinator.configure(
        assets: assets, source: nil, provider: .local(), onSelectAsset: { _ in },
        onPlainPullChanged: { _ in }, onPlainPullEnded: { _, _, _ in })
    }

    private func makeCloudRef(index: Int, script: OutcomeScript? = nil) -> AssetRef {
      let id = "fs:/srv/photos/Library/IMG_\(index).dng"
      return AssetRef(
        displayName: "IMG_\(index).dng",
        hintExtension: "dng",
        stableID: id,
        thumbnailProvenance: .cloud(server: URL(string: "https://a.example.invalid")!),
        displayPreviewProvider: {
          guard let script else { return .notFound(reason: "http 404") }
          return await script.next()
        },
        bytesProvider: { Data() }
      )
    }

    private func encodedImage(size: Int) throws -> Data {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let image = UIGraphicsImageRenderer(
        size: CGSize(width: size, height: size), format: format
      ).image { context in
        context.cgContext.setFillColor(UIColor.green.cgColor)
        context.cgContext.fill(CGRect(x: 0, y: 0, width: size, height: size))
      }
      return try XCTUnwrap(image.pngData())
    }
  }

  /// Serves scripted display-tier outcomes in order, repeating the last.
  private actor OutcomeScript {
    private let outcomes: [PreviewFetchOutcome]
    private(set) var calls = 0

    init(_ outcomes: [PreviewFetchOutcome]) { self.outcomes = outcomes }

    func next() -> PreviewFetchOutcome {
      defer { calls += 1 }
      return outcomes[min(calls, outcomes.count - 1)]
    }
  }
#endif
