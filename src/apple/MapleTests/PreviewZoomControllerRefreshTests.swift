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
      XCTAssertTrue(controller.isAtFitZoom)
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
