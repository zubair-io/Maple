// BackupStatusPanel.swift
//
// Progress display for Settings → Photo Library backup. Binds to
// BackupProgressViewModel which subscribes to BackupQueue.observe() and
// aggregates aggregate counts + currently-uploading + recently-completed.
//
// Surfaces the "see the photos being uploaded and how much is left"
// requirement.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §7, §21.

import SwiftUI
import Photos
import MapleBackup
import MapleCore

struct BackupStatusPanel: View {
  @State private var progress = BackupProgressViewModel()

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ProgressView(value: progress.fractionDone) {
        Text(progress.progressLabel)
          .font(.headline)
      }
      .progressViewStyle(.linear)

      if !progress.inFlight.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text("Uploading now")
            .font(.caption)
            .foregroundStyle(.secondary)
          HStack(spacing: 8) {
            ForEach(progress.inFlight.prefix(3)) { item in
              VStack(spacing: 2) {
                ThumbnailTile(localIdentifier: item.id.phassetLocalId)
                if let fraction = item.fractionDone {
                  Text("\(Int(fraction * 100))%")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                }
              }
            }
            Spacer()
          }
        }
      }

      if !progress.recentCompleted.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text("Recently completed")
            .font(.caption)
            .foregroundStyle(.secondary)
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
              ForEach(progress.recentCompleted) { item in
                ThumbnailTile(localIdentifier: item.id.phassetLocalId, size: 44)
              }
            }
          }
        }
      }

      HStack(spacing: 16) {
        Label("Done: \(progress.totalCompleted.formatted())", systemImage: "checkmark.circle")
          .foregroundStyle(.secondary)
        Label("Failed: \(progress.totalFailed.formatted())", systemImage: "exclamationmark.triangle")
          .foregroundStyle(progress.totalFailed > 0 ? .red : .secondary)
      }
      .font(.caption)

      if let err = progress.lastError {
        Text("Last error: \(err)")
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }

      HStack {
        Button("Pause") {
          Task { await EngineHost.shared.stop() }
        }
        Button("Resume") {
          if let settings = BackupSettings.load() {
            Task { await EngineHost.shared.start(settings: settings) }
          }
        }
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
    }
    .padding(.vertical, 4)
    .task {
      progress.start(queue: EngineHost.shared.queue)
    }
    .onDisappear {
      progress.stop()
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
        RoundedRectangle(cornerRadius: 6)
          .fill(.quaternary)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: 6))
    .task(id: localIdentifier) {
      await loadThumbnail()
    }
  }

  private func loadThumbnail() async {
    let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
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
