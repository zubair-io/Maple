#if os(iOS)
  import MapleCore
  import UIKit
  import XCTest

  @testable import Maple

  @MainActor
  final class PreviewZoomControllerRefreshTests: XCTestCase {
    func testRetainedPageReloadsThumbnailAndDisplayPreviewAfterSave() async throws {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let url = directory.appendingPathComponent("photo.png")
      try encodedImage(size: 32).write(to: url)
      await ThumbnailDiskCache.shared.configure(folderURL: directory)
      await ThumbnailDiskCache.shared.storeThumbnailData(try encodedImage(size: 8), for: url)
      let sink = LocalDisplayPreviewSink(previewURL: MapleSidecarPaths.previewURL(for: url))
      await sink.write(try encodedImage(size: 32))

      let asset = AssetRef(url: url)
      let controller = PreviewZoomController(
        assetID: asset.id, seedKey: url.absoluteString, source: .local(asset, source: nil),
        provider: .local())
      let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
      window.rootViewController = controller
      window.isHidden = false
      defer { window.isHidden = true }
      controller.loadViewIfNeeded()
      controller.view.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
      let scroll = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UIScrollView }.first)
      let image = try XCTUnwrap(scroll.subviews.compactMap { $0 as? UIImageView }.first)
      controller.setRefinementActive(true)
      await waitForPixels(width: 32, in: image)
      attachScreenshot(of: controller.view, name: "Preview before save")

      // Same page controller and asset ID, new saved pixels. A second display
      // request used to be suppressed by loadedMaxDimension even on reappear.
      await ThumbnailDiskCache.shared.storeThumbnailData(try encodedImage(size: 16), for: url)
      await sink.write(try encodedImage(size: 64))
      DevelopedImageRevision.shared.didPersist(for: url)
      await waitForPixels(width: 64, in: image)
      attachScreenshot(of: controller.view, name: "Preview after save")
      XCTAssertTrue(controller.isAtOrBelowFitZoom)
      XCTAssertEqual(image.bounds.size, CGSize(width: 320, height: 320))
      XCTAssertEqual(scroll.minimumZoomScale, CanvasZoomModel.minFitFraction)
      XCTAssertEqual(scroll.maximumZoomScale, 6)
      XCTAssertEqual(controller.fillZoomScale, 1.5, accuracy: 1e-9)
    }

    /// #5710: a taller page leaves a landscape photo's fit rect unchanged
    /// but must still move fill and the letterbox centring.
    func testResizingOnlyTheLetterboxedAxisRecomputesFillAndCentring() throws {
      let page = try makePage(size: CGSize(width: 320, height: 480))
      page.image.image = solidImage(width: 300, height: 200)
      page.layout()
      let fittedHeight: CGFloat = 320 * 200 / 300
      XCTAssertEqual(page.controller.fillZoomScale, 480 / fittedHeight, accuracy: 1e-6)

      page.resize(to: CGSize(width: 320, height: 600))
      XCTAssertEqual(page.image.bounds.height, fittedHeight, accuracy: 1e-6)
      XCTAssertEqual(page.controller.fillZoomScale, 600 / fittedHeight, accuracy: 1e-6)
      XCTAssertEqual(page.scroll.contentInset.top, (600 - fittedHeight) / 2, accuracy: 0.01)
      // UIScrollView snaps content offsets to device pixels.
      XCTAssertEqual(page.scroll.contentOffset.y, -(600 - fittedHeight) / 2, accuracy: 0.5)
    }

    /// #5710: the display tier landing over the thumbnail rounds to a fit
    /// rect 0.67 pt taller on this page; the zoom and the detail in view
    /// survive instead of snapping back to the centre.
    func testSharperTierKeepsTheZoomAndTheDetailInView() throws {
      let page = try makePage(size: CGSize(width: 1366, height: 1024))
      page.image.image = solidImage(width: 512, height: 341)
      page.layout()
      page.scroll.setZoomScale(3, animated: false)
      page.scroll.contentOffset = CGPoint(x: 400, y: 900)
      let before = visibleCentre(of: page.scroll)

      page.image.image = solidImage(width: 2048, height: 1365)
      page.layout()
      XCTAssertEqual(page.image.bounds.height, 1366 * 1365 / 2048, accuracy: 1e-6)
      XCTAssertEqual(page.scroll.zoomScale, 3, accuracy: 1e-6)
      let after = visibleCentre(of: page.scroll)
      XCTAssertEqual(after.x, before.x, accuracy: 1e-3)
      XCTAssertEqual(after.y, before.y, accuracy: 1e-3)
    }

    private struct Page {
      let window: UIWindow
      let controller: PreviewZoomController
      let scroll: UIScrollView
      let image: UIImageView

      func layout() {
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
      }

      func resize(to size: CGSize) {
        window.frame = CGRect(origin: .zero, size: size)
        controller.view.frame = window.bounds
        layout()
      }
    }

    private func makePage(size: CGSize) throws -> Page {
      let missing = FileManager.default.temporaryDirectory.appendingPathComponent(
        "\(UUID().uuidString).png")
      let asset = AssetRef(url: missing)
      let controller = PreviewZoomController(
        assetID: asset.id, seedKey: missing.absoluteString, source: .local(asset, source: nil),
        provider: .local())
      let window = UIWindow(frame: CGRect(origin: .zero, size: size))
      window.rootViewController = controller
      window.isHidden = false
      addTeardownBlock { window.isHidden = true }
      controller.loadViewIfNeeded()
      controller.view.frame = window.bounds
      let scroll = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UIScrollView }.first)
      let image = try XCTUnwrap(scroll.subviews.compactMap { $0 as? UIImageView }.first)
      return Page(window: window, controller: controller, scroll: scroll, image: image)
    }

    private func visibleCentre(of scroll: UIScrollView) -> CGPoint {
      CGPoint(
        x: (scroll.contentOffset.x + scroll.bounds.width / 2) / scroll.contentSize.width,
        y: (scroll.contentOffset.y + scroll.bounds.height / 2) / scroll.contentSize.height)
    }

    private func solidImage(width: Int, height: Int) -> UIImage {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      return UIGraphicsImageRenderer(
        size: CGSize(width: width, height: height), format: format
      ).image { context in
        context.cgContext.setFillColor(UIColor.blue.cgColor)
        context.cgContext.fill(CGRect(x: 0, y: 0, width: width, height: height))
      }
    }

    private func waitForPixels(width: Int, in image: UIImageView) async {
      let deadline = ContinuousClock.now.advanced(by: .seconds(5))
      while image.image?.cgImage?.width != width, ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(10))
      }
      XCTAssertEqual(image.image?.cgImage?.width, width)
    }

    private func encodedImage(size: Int) throws -> Data {
      // Exercise real ImageIO pixels without the simulator's AV1 codec. The
      // AVIF save contract is covered by MapleCore's real GPU-exit tests.
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let image = UIGraphicsImageRenderer(
        size: CGSize(width: size, height: size), format: format
      ).image { context in
        context.cgContext.setFillColor(UIColor.blue.cgColor)
        context.cgContext.fill(CGRect(x: 0, y: 0, width: size, height: size))
      }
      return try XCTUnwrap(image.pngData())
    }

    private func attachScreenshot(of view: UIView, name: String) {
      view.layoutIfNeeded()
      let screenshot = UIGraphicsImageRenderer(bounds: view.bounds).image { context in
        view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: screenshot)
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
