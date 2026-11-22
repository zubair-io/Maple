import MapleCore
import MapleUI
import SwiftUI

#if os(macOS)
  import AppKit

  /// Copy puts the original files on the general pasteboard as file URLs, which
  /// Finder pastes as a copy and other apps receive as files (#6002). Originals
  /// without a local file (server, SMB, Photos Library) are fetched into a private
  /// staging folder first, because a pasteboard file URL must name a real file.
  @MainActor
  final class AssetFileClipboard {
    static let shared = AssetFileClipboard()

    private let stagingRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("Maple Clipboard", isDirectory: true)
    private var copyTask: Task<Void, Never>?

    func copy(_ assets: [AssetRef]) {
      copyTask?.cancel()
      let files = Self.files(for: assets)
      guard !files.isEmpty else { return }
      copyTask = Task { [stagingRoot] in
        do {
          let urls = try await Self.stage(files, in: stagingRoot)
          try Task.checkCancellation()
          Self.publish(urls, scopes: files.compactMap { $0.scopeParentURL ?? $0.primaryURL })
        } catch {
          // A newer Copy replaced this one and cleared its staging folder.
          guard !Task.isCancelled, !(error is CancellationError) else { return }
          NSApp.presentError(error)
        }
      }
    }

    /// A stacked tile copies its JPEG too, as a drag to Finder does (#5050).
    static func files(for assets: [AssetRef]) -> [AssetRef] {
      assets.flatMap { asset in [asset] + (asset.stackCompanionDragAsset.map { [$0] } ?? []) }
    }

    /// Each fetched file gets its own folder, so two originals that share a name
    /// both reach the pasteboard.
    static func stage(_ files: [AssetRef], in root: URL) async throws -> [URL] {
      try? FileManager.default.removeItem(at: root)
      var urls: [URL] = []
      for (index, asset) in files.enumerated() {
        if let url = asset.primaryURL, url.isFileURL {
          urls.append(url)
          continue
        }
        let folder = root.appendingPathComponent(String(index), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(AssetDragFiles.fileName(for: asset))
        try await AssetDragFiles.shared.writeOriginal(asset, to: destination)
        urls.append(destination)
      }
      return urls
    }

    /// Writing while the security scopes are open lets the pasteboard hand
    /// sandboxed receivers access to the user's own files.
    private static func publish(_ urls: [URL], scopes: [URL]) {
      let opened = scopes.filter { $0.startAccessingSecurityScopedResource() }
      defer { opened.forEach { $0.stopAccessingSecurityScopedResource() } }
      let pasteboard = NSPasteboard.general
      pasteboard.clearContents()
      pasteboard.writeObjects(urls.map { $0 as NSURL })
    }
  }

  /// The right-click "Copy" for a tile or the Preview photo.
  struct CopyPhotosMenuItem: View {
    let identifier: String
    let assets: () -> [AssetRef]

    var body: some View {
      Button {
        AssetFileClipboard.shared.copy(assets())
      } label: {
        Label {
          Text("Copy")
        } icon: {
          MuiIcon(name: "content_copy", size: .sm)
        }
      }
      .accessibilityIdentifier(identifier)
    }
  }
#endif

extension View {
  /// Right-click "Copy" for the photo a surface shows; macOS only.
  func copyPhotoContextMenu(_ asset: AssetRef, identifier: String) -> some View {
    #if os(macOS)
      contextMenu { CopyPhotosMenuItem(identifier: identifier) { [asset] } }
    #else
      self
    #endif
  }
}
