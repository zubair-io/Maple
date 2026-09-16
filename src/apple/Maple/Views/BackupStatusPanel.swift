// BackupStatusPanel.swift
//
// Progress display for Settings → Photo Library backup. Binds to
// BackupProgressViewModel which subscribes to BackupQueue.observe() and
// aggregates aggregate counts + currently-uploading + recently-completed.
//
// Surfaces the "see the photos being uploaded and how much is left"
// requirement.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §7, §21.

import MapleBackup
import MapleCore
import Photos
import SwiftUI

struct BackupStatusPanel: View {
  // Use the engine-hosted VM so progress survives navigation.
  // The instance lives on EngineHost.shared for the lifetime of the process;
  // presenting this panel multiple times always shows the same running totals.
  var progress: BackupProgressViewModel = EngineHost.shared.progress

  @State private var issueSheet: IssueSheet?
  private enum IssueSheet: String, Identifiable {
    case warnings, errors
    var id: String { rawValue }
  }

  // MARK: - #711 fixed-height thumbnail strips
  //
  // Anchored to `ThumbnailTile`'s sizes so the reserved heights can't drift
  // from the tiles if those sizes change.

  /// Default `ThumbnailTile` size used by the "Uploading now" tiles.
  private static let uploadTileSize: CGFloat = 64
  /// Tile size for the "Recently completed" strip (`ThumbnailTile(size:)`).
  private static let recentTileSize: CGFloat = 44
  /// Point size of the per-tile "%" label under an uploading tile.
  private static let uploadLabelFontSize: CGFloat = 9
  /// Reserved height for an "Uploading now" tile column: tile + inner VStack
  /// spacing (2) + the always-present % label line. A 9pt system font lays out
  /// at roughly 11pt; reserve 12 so a populated row never exceeds the frame.
  private static let uploadRowHeight: CGFloat = uploadTileSize + 2 + 12

  /// True while a backup is in any active phase (running / paused /
  /// restarting). `.starting` matters most here: it's exactly when the
  /// engine tears down and `inFlight` empties, so it must keep the strip
  /// mounted to avoid the collapse-and-snap flicker.
  private var isBackupActive: Bool {
    progress.phase != .stopped
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      // One row communicates both run state and connection route.
      statusRow

      ProgressView(value: progress.fractionDone) {
        Text(progress.progressLabel)
          .font(.headline)
      }
      .progressViewStyle(.linear)

      BackupActivityLine(progress: progress)

      // Reserve both strips throughout a run so worker churn cannot move the controls.
      if isBackupActive || !progress.inFlight.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          ScrollView(.horizontal) {
            HStack(spacing: 8) {
              ForEach(progress.inFlight) { item in
                VStack(spacing: 2) {
                  // `size:` is pinned to the same constant that drives
                  // `uploadRowHeight` so the tile and the reserved row height
                  // can't drift apart (review on #711).
                  ThumbnailTile(localIdentifier: item.id.phassetLocalId, size: Self.uploadTileSize)
                  let state = BackupStatusPresentation.tile(item)
                  HStack(spacing: 3) {
                    Image(systemName: state.symbol)
                    if !state.text.isEmpty { Text(state.text) }
                  }
                  .font(.system(size: Self.uploadLabelFontSize))
                  .foregroundStyle(.secondary)
                  .monospacedDigit()
                  .lineLimit(1)
                  .frame(width: Self.uploadTileSize, height: 12)
                  .accessibilityElement(children: .ignore)
                  .accessibilityLabel(BackupStatusPresentation.tileLabel(item))
                  .help(BackupStatusPresentation.tileLabel(item))

                }
              }
              Spacer()
            }
          }
          .frame(height: Self.uploadRowHeight, alignment: .top)
        }
      }

      if isBackupActive || !progress.recentCompleted.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text("Recently completed")
            .font(.caption)
            .foregroundStyle(.secondary)
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
              ForEach(progress.recentCompleted) { item in
                ThumbnailTile(localIdentifier: item.id.phassetLocalId, size: Self.recentTileSize)
              }
            }
          }
          .frame(height: Self.recentTileSize, alignment: .top)
        }
      }

      // Session uploads are separate from the whole-library progress above.
      // Related files can continue retrying after an original is saved.
      HStack(spacing: 16) {
        Label("This run: \(progress.totalCompleted.formatted())", systemImage: "checkmark.circle")
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("backup.status.done")
        Spacer(minLength: 0)
        issueButton(
          .warnings, count: progress.issues.warningCount,
          symbol: "exclamationmark.triangle", color: .orange)
        issueButton(
          .errors,
          count: BackupStatusPresentation.failureCount(
            progress, startError: EngineHost.shared.lastStartError),
          symbol: "exclamationmark.circle", color: .red)
      }
      .font(.caption)
    }
    .padding(.vertical, 4)
    .sheet(item: $issueSheet) { selection in
      BackupIssueDetails(
        progress: progress, failures: selection == .errors,
        startError: EngineHost.shared.lastStartError)
    }
  }

  private func issueButton(_ kind: IssueSheet, count: Int, symbol: String, color: Color)
    -> some View
  {
    Button {
      issueSheet = kind
    } label: {
      Label(count.formatted(), systemImage: symbol)
        .monospacedDigit()
        .foregroundStyle(count > 0 ? color : .secondary)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(count) backup \(kind.rawValue). Show details")
    .accessibilityIdentifier("backup.status.\(kind.rawValue)")
    .help("Show backup \(kind.rawValue)")
  }

  // MARK: - Status row

  /// The connection glyph replaces the run-state dot. VoiceOver and help
  /// describe the route explicitly so color is never the only signal.
  @ViewBuilder
  private var statusRow: some View {
    HStack(spacing: 8) {
      Image(
        systemName: EngineHost.shared.usesLocalAddress
          ? "point.3.connected.trianglepath.dotted" : "network"
      )
      .font(.headline)
      .foregroundStyle(statusColor)
      .frame(width: 20)
      .accessibilityHidden(true)
      Text(progress.phase.label)
        .font(.headline)
      Spacer()
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Backup status: \(progress.phase.label). \(connectionLabel)")
    .help(connectionLabel)
    .accessibilityIdentifier("backup.status.phase")
  }

  private var connectionLabel: String {
    guard EngineHost.shared.uploadAddress != nil else { return "Connection not established" }
    let route = EngineHost.shared.usesLocalAddress ? "Local network" : "Internet connection"
    return progress.phase == .stopped ? "Last connection: \(route)" : route
  }

  private var statusColor: Color {
    switch progress.phase {
    case .running: return EngineHost.shared.usesLocalAddress ? .green : .orange
    case .starting: return .orange
    case .stopped: return .secondary
    }
  }
}

private struct ThumbnailTile: View {
  let localIdentifier: String
  var size: CGFloat = 64

  @State private var image: PlatformImage?

  var body: some View {
    Group {
      if let img = image {
        platformImageView(img)
          .resizable()
          .aspectRatio(contentMode: .fill)
      } else {
        RoundedRectangle(cornerRadius: MapleTokens.Radius.sm)
          .fill(.quaternary)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
    .task(id: localIdentifier) {
      await loadThumbnail()
    }
  }

  private func loadThumbnail() async {
    let asset = PhotoKitCatalog.shared.asset(localId: localIdentifier)
    guard let asset else { return }
    let options = PHImageRequestOptions()
    options.deliveryMode = .opportunistic
    options.resizeMode = .fast
    options.isNetworkAccessAllowed = false
    let target = CGSize(width: size * 2, height: size * 2)  // @2x for retina
    let img: PlatformImage? = await withCheckedContinuation {
      (continuation: CheckedContinuation<PlatformImage?, Never>) in
      // Resume-latch — `.opportunistic` may call the handler twice (low-res
      // then hi-res). We're happy with whichever resolves first; resuming
      // twice would crash.
      final class Latch: @unchecked Sendable {
        private let lock = NSLock()
        private var fired = false
        func tryFire() -> Bool {
          lock.lock()
          defer { lock.unlock() }
          if fired { return false }
          fired = true
          return true
        }
      }
      let latch = Latch()
      PHImageManager.default().requestImage(
        for: asset, targetSize: target,
        contentMode: .aspectFill, options: options
      ) { image, info in
        let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
        if degraded { return }  // wait for hi-res
        if latch.tryFire() { continuation.resume(returning: image) }
      }
    }
    await MainActor.run { self.image = img }
  }
}

// Cross-platform image alias + view builder. PhotoKit returns UIImage on UIKit
// platforms and NSImage on AppKit.
#if canImport(UIKit)
  import UIKit
  typealias PlatformImage = UIImage
  private func platformImageView(_ image: UIImage) -> Image { Image(uiImage: image) }
#elseif canImport(AppKit)
  import AppKit
  typealias PlatformImage = NSImage
  private func platformImageView(_ image: NSImage) -> Image { Image(nsImage: image) }
#endif

// MARK: - Previews
//
// Issue #139 — backup progress panel. Reads from `EngineHost.shared.progress`,
// which on a cold preview is empty (no engine running) — that exercises the
// "No photos queued" empty layout. Pause/Resume buttons are wired but the
// engine doesn't actually start in a preview because the settings file is
// absent.

#Preview("Default — no backup running") {
  BackupStatusPanel()
    .padding()
    .frame(width: 360)
}
