#if os(macOS)
  import AppKit
  import CoreTransferable
  import MapleCore
  import UniformTypeIdentifiers
  import XCTest
  @testable import Maple

  final class MacAssetDragItemTests: XCTestCase {
    @available(macOS 15.2, *)
    @MainActor
    func testSelectionPublishesSeparateFileItemsWithoutPlainText() async throws {
      let assets = ["One photo.dng", "Two photo.jpg"].map {
        AssetRef(url: FileManager.default.temporaryDirectory.appendingPathComponent($0))
      }
      let ids = assets.map(\.id)
      let items = assets.map { MacAssetDragItem(asset: $0) }
      let pasteboard = NSPasteboard.withUniqueName()
      defer { pasteboard.releaseGlobally() }
      XCTAssertTrue(pasteboard.writeObjects(items))
      XCTAssertEqual(pasteboard.pasteboardItems?.count, 2)
      let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL]
      XCTAssertEqual(urls, assets.compactMap(\.primaryURL))
      var drops: [AssetOrFileDrop] = []
      for (item, asset) in zip(try XCTUnwrap(pasteboard.pasteboardItems), assets) {
        XCTAssertNil(item.string(forType: .string))
        let data = try XCTUnwrap(item.data(forType: .init(UTType.mapleAssetSelection.identifier)))
        let payload = try await DraggedAssetPayload(
          importing: data, contentType: .mapleAssetSelection)
        XCTAssertEqual(payload.ids, [asset.id])
        drops.append(.selection(payload))
      }
      XCTAssertEqual(AssetOrFileDrop.assetIDs(in: drops), Set(ids))
    }

    @MainActor
    func testOutgoingOperationOnlyPermitsCopy() {
      // The mask is independent of Option/Command and may never permit an external move.
      XCTAssertEqual(MacAssetDragSource.DragView.operationMask(for: .outsideApplication), .copy)
      XCTAssertEqual(
        MacAssetDragSource.DragView.operationMask(for: .withinApplication), [.copy, .move])
    }

    @MainActor
    func testRemoteFilePromiseWritesOriginalBytes() async throws {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString, isDirectory: true)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: root) }
      let bytes = Data([0xFF, 0xD8, 0, 0xFF, 0xD9])
      let asset = AssetRef(
        displayName: "Remote photo.jpg", hintExtension: "jpg",
        originalFileWriter: { try bytes.write(to: $0) },
        bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
      let item = MacAssetDragItem(asset: asset)
      let pasteboard = NSPasteboard.withUniqueName()
      defer { pasteboard.releaseGlobally() }
      XCTAssertTrue(pasteboard.writeObjects([item]))
      XCTAssertFalse(item.writableTypes(for: pasteboard).contains(.fileURL))
      let receivers = try XCTUnwrap(
        pasteboard.readObjects(forClasses: [NSFilePromiseReceiver.self]) as? [NSFilePromiseReceiver]
      )
      XCTAssertEqual(receivers.count, 1)
      XCTAssertEqual(receivers[0].fileTypes, [UTType.jpeg.identifier])
      // AppKit allows receivePromisedFiles only inside a live drop callback.
      // Exercise the provider's actual delegate and original-copy path here.
      let name = item.filePromiseProvider(item, fileNameForType: item.fileType)
      let output = root.appendingPathComponent(name)
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, Error>) in
        item.filePromiseProvider(item, writePromiseTo: output) { error in
          if let error { continuation.resume(throwing: error) } else { continuation.resume() }
        }
      }
      XCTAssertEqual(name, "Remote photo.jpg")
      XCTAssertEqual(try Data(contentsOf: output), bytes)
    }

    @MainActor
    func testSidebarPrefersInternalSelectionWhenFileURLIsAlsoAvailable() async throws {
      let payload = DraggedAssetPayload(ids: [UUID(), UUID()])
      let provider = NSItemProvider()
      provider.register(URL(fileURLWithPath: "/tmp/photo.dng"))
      provider.register(payload)
      let drop: AssetOrFileDrop = try await withCheckedThrowingContinuation { continuation in
        provider.loadTransferable(type: AssetOrFileDrop.self) { result in
          continuation.resume(with: result)
        }
      }
      XCTAssertEqual(AssetOrFileDrop.assetIDs(in: [drop, drop]), Set(payload.ids))
    }

    @MainActor
    func testSidebarStillAcceptsIncomingFileURLs() async throws {
      let url = URL(fileURLWithPath: "/tmp/incoming-photo.dng")
      let provider = NSItemProvider()
      provider.register(url)
      let drop: AssetOrFileDrop = try await withCheckedThrowingContinuation { continuation in
        provider.loadTransferable(type: AssetOrFileDrop.self) { result in
          continuation.resume(with: result)
        }
      }
      guard case .file(let imported) = drop else { return XCTFail("Expected an incoming file URL") }
      XCTAssertEqual(imported, url)
    }
  }
#endif
