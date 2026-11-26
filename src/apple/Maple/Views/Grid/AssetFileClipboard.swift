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

    private let stagingRoot: URL
    private let publish: @MainActor (_ urls: [URL], _ scopes: [URL]) -> Bool
    private let report: @MainActor (Error) -> Void
    private(set) var copyTask: Task<Void, Never>?

    init(
      stagingRoot: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("Maple Clipboard", isDirectory: true),
      publish: @escaping @MainActor (_ urls: [URL], _ scopes: [URL]) -> Bool =
        AssetFileClipboard.writeToGeneralPasteboard,
      report: @escaping @MainActor (Error) -> Void = { NSApp.presentError($0) }
    ) {
      self.stagingRoot = stagingRoot
      self.publish = publish
      self.report = report
    }

    func copy(_ assets: [AssetRef]) {
      let files = Self.files(for: assets)
      guard !files.isEmpty else { return }
      copyTask?.cancel()
      let batch = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
      copyTask = Task { [stagingRoot, publish, report] in
        do {
          let urls = try await Self.stage(files, in: batch)
          try Task.checkCancellation()
          guard publish(urls, files.compactMap { $0.scopeParentURL ?? $0.primaryURL }) else {
            throw FileOperationError.underlying("The photos couldn't be copied to the clipboard.")
          }
          Self.removeStagedCopies(in: stagingRoot, except: batch)
        } catch {
          try? FileManager.default.removeItem(at: batch)
          guard !Task.isCancelled, !(error is CancellationError) else { return }
          report(error)
        }
      }
    }

    /// A stacked tile copies its JPEG too, as a drag to Finder does (#5050).
    static func files(for assets: [AssetRef]) -> [AssetRef] {
      assets.flatMap { asset in [asset] + (asset.stackCompanionDragAsset.map { [$0] } ?? []) }
    }

    /// Each fetched file gets its own folder, so two originals that share a name
    /// both reach the pasteboard.
    static func stage(_ files: [AssetRef], in batch: URL) async throws -> [URL] {
      var urls: [URL] = []
      for (index, asset) in files.enumerated() {
        if let url = asset.primaryURL, url.isFileURL {
          urls.append(url)
          continue
        }
        let folder = batch.appendingPathComponent(String(index), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(AssetDragFiles.fileName(for: asset))
        try await AssetDragFiles.shared.writeOriginal(asset, to: destination)
        urls.append(destination)
      }
      return urls
    }

    /// The clipboard's current files stay until a replacement has been published,
    /// so a paste during a slow or failed fetch still finds them.
    static func removeStagedCopies(in root: URL, except batch: URL) {
      let staged =
        (try? FileManager.default.contentsOfDirectory(
          at: root, includingPropertiesForKeys: nil)) ?? []
      // Only a copy's own UUID-named folder is ever removed, whatever `root` holds.
      staged.filter {
        UUID(uuidString: $0.lastPathComponent) != nil
          && $0.standardizedFileURL != batch.standardizedFileURL
      }.forEach {
        try? FileManager.default.removeItem(at: $0)
      }
    }

    /// Writing while the security scopes are open lets the pasteboard hand
    /// sandboxed receivers access to the user's own files.
    static func writeToGeneralPasteboard(_ urls: [URL], scopes: [URL]) -> Bool {
      let opened = scopes.filter { $0.startAccessingSecurityScopedResource() }
      defer { opened.forEach { $0.stopAccessingSecurityScopedResource() } }
      let pasteboard = NSPasteboard.general
      pasteboard.clearContents()
      return pasteboard.writeObjects(urls.map { $0 as NSURL })
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
