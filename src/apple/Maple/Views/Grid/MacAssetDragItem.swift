#if os(macOS)
  import AppKit
  import MapleCore
  import UniformTypeIdentifiers

  /// Each photo is one pasteboard item: Finder gets a file URL or file promise,
  /// while Maple's drop targets collect each photo's internal identity.
  final class MacAssetDragItem: NSFilePromiseProvider, NSFilePromiseProviderDelegate {
    let asset: AssetRef
    let selection: Data
    private let scope: URL?
    private let accessing: Bool

    init(asset: AssetRef) {
      self.asset = asset
      self.selection = Data(asset.id.uuidString.utf8)
      self.scope = asset.scopeParentURL ?? asset.primaryURL
      self.accessing = scope?.startAccessingSecurityScopedResource() ?? false
      super.init()
      fileType =
        UTType(filenameExtension: (AssetDragFiles.fileName(for: asset) as NSString).pathExtension)?
        .identifier ?? UTType.data.identifier
      delegate = self
    }

    deinit { if accessing { scope?.stopAccessingSecurityScopedResource() } }

    override func writableTypes(for pasteboard: NSPasteboard) -> [NSPasteboard.PasteboardType] {
      let identity = NSPasteboard.PasteboardType(UTType.mapleAssetSelection.identifier)
      let local: [NSPasteboard.PasteboardType] =
        asset.primaryURL?.isFileURL == true ? [.fileURL] : []
      return [identity] + local + super.writableTypes(for: pasteboard)
    }

    override func pasteboardPropertyList(forType type: NSPasteboard.PasteboardType) -> Any? {
      if type.rawValue == UTType.mapleAssetSelection.identifier { return selection }
      if type == .fileURL, let url = asset.primaryURL, url.isFileURL {
        return (url as NSURL).pasteboardPropertyList(forType: type)
      }
      return super.pasteboardPropertyList(forType: type)
    }

    func filePromiseProvider(
      _ filePromiseProvider: NSFilePromiseProvider, fileNameForType fileType: String
    ) -> String {
      AssetDragFiles.fileName(for: asset)
    }

    func filePromiseProvider(
      _ filePromiseProvider: NSFilePromiseProvider, writePromiseTo url: URL,
      completionHandler: @escaping ((any Error)?) -> Void
    ) {
      Task {
        do {
          try await AssetDragFiles.shared.writeOriginal(asset, to: url)
          completionHandler(nil)
        } catch {
          completionHandler(error)
        }
      }
    }
  }
#endif
