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

import SwiftUI
import Photos
import MapleBackup
import MapleCore

struct BackupStatusPanel: View {
  // Use the engine-hosted VM so progress survives navigation.
  // The instance lives on EngineHost.shared for the lifetime of the process;
  // presenting this panel multiple times always shows the same running totals.
  private var progress: BackupProgressViewModel { EngineHost.shared.progress }

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
  /// restarting). `.restarting` matters most here: it's exactly when the
  /// engine tears down and `inFlight` empties, so it must keep the strip
  /// mounted to avoid the collapse-and-snap flicker.
  private var isBackupActive: Bool {
    progress.phase != .stopped
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      // Run-state row — the PRIMARY fix for "the panel never tells me whether
      // backup is running". Reads `progress.phase`, which `EngineHost` drives
      // through the real engine lifecycle (Stopped / Running / Paused /
      // Restarting…). `@Observable` makes this update reactively.
      statusRow

      // Surface engine-startup failures right at the top. Without this,
      // a failed `EngineHost.start` left the user staring at a
      // "No photos queued" panel with no idea why nothing was happening.
      if let startErr = EngineHost.shared.lastStartError {
        Label(startErr, systemImage: "exclamationmark.triangle.fill")
          .font(.callout)
          .foregroundStyle(.red)
          .padding(8)
          .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
          .accessibilityIdentifier("backup.status.startError")
      }

      ProgressView(value: progress.fractionDone) {
        Text(progress.progressLabel)
          .font(.headline)
      }
      .progressViewStyle(.linear)

      // Library-scan row (#3386): the PhotoKit walk that seeds the queue
      // runs for minutes on a large library while `totalEnqueued` is still
      // 0, so without this the panel read "Running · No photos queued" for
      // the whole scan and looked wedged. A walk that bails reports why.
      if let walkLabel = progress.walkPhaseLabel {
        walkRow(label: walkLabel)
      }

      // Completion caption (#3097): when the last walk confirmed everything
      // is backed up, say when it checked and surface any terminal failures
      // (photos that ran out of retries — e.g. deleted from Photos before
      // their upload finished). Session-scoped failures stay on the
      // "Failed:" row below; this is the persisted, cross-session figure.
      if progress.isAllBackedUp, let summary = progress.lastWalkSummary {
        VStack(alignment: .leading, spacing: 2) {
          Text("Library checked \(summary.finishedAt.formatted(.relative(presentation: .named))).")
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("backup.status.allBackedUp")
          if summary.failedPermanently > 0 {
            Label("\(summary.failedPermanently.formatted()) photos failed permanently and won't be retried.",
                  systemImage: "exclamationmark.triangle")
              .font(.caption)
              .foregroundStyle(.orange)
              .accessibilityIdentifier("backup.status.failedPermanently")
          }
        }
      }

      // Live throughput (#702) — rolling-window bytes/sec + photos/min from the
      // same .progress/.completed events the counters use. Hidden when idle.
      if let throughput = progress.throughputLabel {
        Label(throughput, systemImage: "gauge.with.dots.needle.67percent")
          .font(.caption)
          .foregroundStyle(.secondary)
          .monospacedDigit()
          .accessibilityIdentifier("backup.status.throughput")
      }

      // "Uploading now" + "Recently completed" thumbnail strips.
      //
      // #711: while a backup is active these rows reserve a STABLE height and
      // toggle only their *content*, never the whole section. `inFlight` blips
      // empty for a frame as one upload finishes before the next starts; if the
      // `if` gated the section we'd un-render → collapse → snap back → flicker.
      // Keeping the container mounted at a fixed height absorbs that blip.
      //
      // The reserved height is the row at its *tallest* (tile + % label slot),
      // so the frame never grows when tiles/labels appear. The % label slot is
      // always rendered (an empty placeholder when `fractionDone == nil`) so a
      // per-tile label arriving/clearing can't change the row height either.
      //
      // Shown when a backup is active OR the list is non-empty: `active` covers
      // the blip-empty flicker, `!isEmpty` keeps a finished backup's results
      // visible after the engine returns to `.stopped`.
      if isBackupActive || !progress.inFlight.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text("Uploading now")
            .font(.caption)
            .foregroundStyle(.secondary)
          HStack(spacing: 8) {
            ForEach(progress.inFlight.prefix(3)) { item in
              VStack(spacing: 2) {
                // `size:` is pinned to the same constant that drives
                // `uploadRowHeight` so the tile and the reserved row height
                // can't drift apart (review on #711).
                ThumbnailTile(localIdentifier: item.id.phassetLocalId, size: Self.uploadTileSize)
                // Always reserve the label line so a tile's height is stable
                // whether or not a fraction has arrived yet. The placeholder
                // is hidden from VoiceOver so the blank line isn't an empty
                // accessibility element (review on #711).
                Text(item.fractionDone.map { "\(Int($0 * 100))%" } ?? " ")
                  .font(.system(size: Self.uploadLabelFontSize))
                  .foregroundStyle(.secondary)
                  .monospacedDigit()
                  .accessibilityHidden(item.fractionDone == nil)
              }
            }
            Spacer()
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

      // Three-way status breakdown (#702): fully done (bytes + all companions),
      // uploaded with a companion still retrying, and truly failed (bytes
      // exhausted). Replaces the old single Done/Failed pair.
      HStack(spacing: 16) {
        Label("Done: \(progress.doneCount.formatted())", systemImage: "checkmark.circle")
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("backup.status.done")
        if progress.uploadedCompanionsPendingCount > 0 {
          Label("Finishing: \(progress.uploadedCompanionsPendingCount.formatted())",
                systemImage: "arrow.triangle.2.circlepath")
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("backup.status.companionsPending")
            .help("Uploaded — sidecar/rendered companions still finishing in the background.")
        }
        Label("Failed: \(progress.totalFailed.formatted())", systemImage: "exclamationmark.triangle")
          .foregroundStyle(progress.totalFailed > 0 ? .red : .secondary)
          .accessibilityIdentifier("backup.status.failed")
      }
      .font(.caption)

      if let err = progress.lastError {
        Text("Last error: \(err)")
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }

      HStack {
        // Pause is only meaningful while the engine is actively running.
        Button("Pause") {
          Task { await EngineHost.shared.pause() }
        }
        .disabled(progress.phase != .running)
        .accessibilityIdentifier("backup.pauseButton")

        // Resume only when paused or fully stopped. `EngineHost.resume()`
        // surfaces a visible error (via lastStartError → the banner above) if
        // settings can't be loaded, instead of the old silent no-op.
        Button("Resume") {
          Task { await EngineHost.shared.resume() }
        }
        .disabled(!(progress.phase == .paused || progress.phase == .stopped))
        .accessibilityIdentifier("backup.resumeButton")

        // While a restart is in flight, show an inline spinner so the controls
        // don't look frozen during the (potentially slow) teardown + walk.
        if progress.phase == .restarting {
          ProgressView()
            .controlSize(.small)
            .accessibilityIdentifier("backup.restartingSpinner")
        }
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
    }
    .padding(.vertical, 4)
    // No .task / .onDisappear here: the progress VM is now hoisted onto
    // `EngineHost.shared.progress` (main, PR #49 follow-up) so its
    // observer lifecycle is tied to the engine's start/stop, not to the
    // panel's appearance. Running totals therefore survive navigating
    // away from Settings and back. The `lastStartError` banner above
    // covers the "engine didn't actually start" diagnostic that the old
    // .task path used to surface implicitly.
  }

  // MARK: - Library-scan row (#3386)

  @ViewBuilder
  private func walkRow(label: String) -> some View {
    if case .failed = progress.walkPhase {
      Label(label, systemImage: "exclamationmark.triangle.fill")
        .font(.caption)
        .foregroundStyle(.red)
        .accessibilityIdentifier("backup.status.walkFailed")
    } else {
      HStack(spacing: 8) {
        if let fraction = progress.walkFraction {
          ProgressView(value: fraction)
            .progressViewStyle(.linear)
            .frame(maxWidth: 120)
        } else {
          ProgressView()
            .controlSize(.small)
        }
        Text(label)
          .font(.caption)
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
      .accessibilityIdentifier("backup.status.walkPhase")
    }
  }

  // MARK: - Status row

  /// Prominent run-state row at the top of the panel. The dot + label make the
  /// current phase legible at a glance; the whole row carries a single
  /// accessibility label ("Backup status: Running") so UI tests and
  /// VoiceOver can read the phase directly.
  @ViewBuilder
  private var statusRow: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(statusColor)
        .frame(width: 10, height: 10)
      Text(progress.phase.label)
        .font(.headline)
      Spacer()
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Backup status: \(progress.phase.label)")
    .accessibilityIdentifier("backup.status.phase")
  }

  private var statusColor: Color {
    switch progress.phase {
    case .running: return .green
    case .paused: return .orange
    case .restarting: return .blue
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
    let img: PlatformImage? = await withCheckedContinuation { (continuation: CheckedContinuation<PlatformImage?, Never>) in
      // Resume-latch — `.opportunistic` may call the handler twice (low-res
      // then hi-res). We're happy with whichever resolves first; resuming
      // twice would crash.
      final class Latch: @unchecked Sendable {
        private let lock = NSLock(); private var fired = false
        func tryFire() -> Bool { lock.lock(); defer { lock.unlock() }; if fired { return false }; fired = true; return true }
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
