import MapleCore
import MapleUI
import Observation
import SwiftUI

#if os(macOS)
  import AppKit

  /// Copy puts copies of the original files on the general pasteboard as file
  /// URLs, which Finder pastes and other apps receive as files (#6002). Every
  /// original is first copied into a private staging folder: a local original's
  /// own path would let Finder's "Move Item Here" take it out of the library (#6174).
  /// The staged copies are removed when Maple quits or starts, and `lifetime` after
  /// the copy was published (#6209).
  @MainActor
  @Observable
  final class AssetFileClipboard {
    static let defaultLifetime: Duration = .seconds(4 * 3600)
    static let shared = AssetFileClipboard()

    /// Set while the originals of a Copy that includes a remote file are being fetched.
    private(set) var progress: AssetCopyProgress?

    private let stagingRoot: URL
    private let publish: @MainActor (_ urls: [URL]) -> Bool
    private let report: @MainActor (Error) -> Void
    private let lifetime: Duration
    @ObservationIgnored private(set) var copyTask: Task<Void, Never>?
    @ObservationIgnored private(set) var expiryTask: Task<Void, Never>?
    private let notificationCenter: NotificationCenter
    @ObservationIgnored private var terminationObserver: NSObjectProtocol?

    init(
      stagingRoot: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("Maple Clipboard", isDirectory: true),
      lifetime: Duration = AssetFileClipboard.defaultLifetime,
      publish: @escaping @MainActor (_ urls: [URL]) -> Bool =
        AssetFileClipboard.writeToGeneralPasteboard,
      report: @escaping @MainActor (Error) -> Void = { NSApp.presentError($0) },
      notificationCenter: NotificationCenter = .default
    ) {
      self.notificationCenter = notificationCenter
      self.stagingRoot = stagingRoot
      self.lifetime = lifetime
      self.publish = publish
      self.report = report
      Self.removeStagedCopies(in: stagingRoot, except: nil)
      terminationObserver = notificationCenter.addObserver(
        forName: NSApplication.willTerminateNotification, object: nil, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.removeAllStagedCopies() }
      }
    }

    deinit {
      if let terminationObserver { notificationCenter.removeObserver(terminationObserver) }
    }

    func copy(_ assets: [AssetRef]) {
      let files = Self.files(for: assets)
      guard !files.isEmpty else { return }
      copyTask?.cancel()
      let batch = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let copyProgress =
        files.contains(where: Self.isRemote) ? AssetCopyProgress(fileCount: files.count) : nil
      progress = copyProgress
      copyTask = Task { [self, stagingRoot, publish, report] in
        defer {
          if progress === copyProgress { progress = nil }
        }
        do {
          let urls = try await Self.stage(files, in: batch, progress: copyProgress)
          try Task.checkCancellation()
          guard publish(urls) else {
            throw FileOperationError.underlying("The photos couldn't be copied to the clipboard.")
          }
          Self.removeStagedCopies(in: stagingRoot, except: batch)
          scheduleExpiry(of: batch)
        } catch {
          try? FileManager.default.removeItem(at: batch)
          guard !Task.isCancelled, !(error is CancellationError) else { return }
          report(error)
        }
      }
    }

    func cancelCopy() { copyTask?.cancel() }

    /// The published copies stay for `lifetime`, then go; a later copy replaces them sooner.
    private func scheduleExpiry(of batch: URL) {
      expiryTask?.cancel()
      expiryTask = Task { [lifetime] in
        try? await Task.sleep(for: lifetime)
        guard !Task.isCancelled else { return }
        try? FileManager.default.removeItem(at: batch)
      }
    }

    private func removeAllStagedCopies() {
      copyTask?.cancel()
      expiryTask?.cancel()
      Self.removeStagedCopies(in: stagingRoot, except: nil)
    }

    /// A server or share original: the writers that report a transfer.
    private static func isRemote(_ asset: AssetRef) -> Bool {
      asset.primaryURL?.isFileURL != true && asset.originalFileWriter != nil
    }

    /// A stacked tile copies its JPEG too, as a drag to Finder does (#5050).
    static func files(for assets: [AssetRef]) -> [AssetRef] {
      assets.flatMap { asset in [asset] + (asset.stackCompanionDragAsset.map { [$0] } ?? []) }
    }

    /// Each fetched file gets its own folder, so two originals that share a name
    /// both reach the pasteboard.
    static func stage(
      _ files: [AssetRef], in batch: URL, progress: AssetCopyProgress? = nil
    ) async throws -> [URL] {
      var urls: [URL] = []
      for (index, asset) in files.enumerated() {
        try Task.checkCancellation()
        let folder = batch.appendingPathComponent(String(index), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(AssetDragFiles.fileName(for: asset))
        try await AssetDragFiles.shared.writeOriginal(
          asset, to: destination,
          onProgress: { received, total in
            Task { @MainActor in
              progress?.report(received: received, total: total, forFile: index)
            }
          })
        progress?.finishFile()
        urls.append(destination)
      }
      return urls
    }

    /// The clipboard's current files stay until a replacement has been published,
    /// so a paste during a slow or failed fetch still finds them.
    static func removeStagedCopies(in root: URL, except batch: URL?) {
      let staged =
        (try? FileManager.default.contentsOfDirectory(
          at: root, includingPropertiesForKeys: nil)) ?? []
      // Only a copy's own UUID-named folder is ever removed, whatever `root` holds.
      staged.filter {
        UUID(uuidString: $0.lastPathComponent) != nil
          && $0.standardizedFileURL != batch?.standardizedFileURL
      }.forEach {
        try? FileManager.default.removeItem(at: $0)
      }
    }

    static func writeToGeneralPasteboard(_ urls: [URL]) -> Bool {
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
