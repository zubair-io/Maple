// PanoDownloadSection.swift — the merge sheet's "download the frames first"
// step for cloud-only frames stitched on this device (#5489).
//
// Shows the size up front with free space and a cellular / Low Data Mode
// warning, then per-file and overall progress with Cancel. Nothing downloads
// until the user taps Download.

import MapleCore
import MapleUI
import SwiftUI

struct PanoDownloadSection: View {
  let download: PanoFrameDownload
  let onRetry: () -> Void

  var body: some View {
    Section {
      switch download.state {
      case .idle, .estimating:
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Checking the frames’ size…")
            .foregroundStyle(.secondary)
        }
      case .ready(let estimate):
        ready(estimate)
      case .downloading(let progress):
        downloading(progress)
      case .downloaded:
        Label {
          Text("Frames downloaded")
        } icon: {
          MuiIcon(name: "check", size: .sm)
        }
      case .failed(let message):
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
        Button("Try Again", action: onRetry)
          .accessibilityLabel("Try downloading the frames again")
      }
    } header: {
      Text("Download Frames")
    } footer: {
      Text(
        "The frames download to a temporary cache on this device, never into your library, and are removed after the stitch."
      )
    }
  }

  @ViewBuilder
  private func ready(_ estimate: PanoDownloadEstimate) -> some View {
    LabeledContent("Download", value: Self.bytes(estimate.remainingBytes))
      .accessibilityIdentifier("pano-download-size")
    if estimate.cachedBytes > 0 {
      LabeledContent("Already downloaded", value: Self.bytes(estimate.cachedBytes))
    }
    if let free = estimate.freeBytes {
      LabeledContent("Free on this device", value: Self.bytes(free))
    }
    if !estimate.fits {
      warning(
        "There isn’t room. Free up \(Self.bytes(estimate.remainingBytes + PanoDownloadEstimate.headroomBytes - (estimate.freeBytes ?? 0))) and try again."
      )
    } else if estimate.network.constrained {
      warning(
        "Low Data Mode is on. Downloading these frames uses \(Self.bytes(estimate.remainingBytes))."
      )
    } else if estimate.network.expensive {
      warning(
        "You’re on cellular. Downloading these frames uses \(Self.bytes(estimate.remainingBytes)).")
    }
    if estimate.fits {
      Button(
        estimate.remainingBytes > 0
          ? "Download \(Self.bytes(estimate.remainingBytes))" : "Use Downloaded Frames"
      ) {
        download.start()
      }
      .accessibilityIdentifier("pano-download-start")
    } else {
      Button("Check Again", action: onRetry)
    }
  }

  private func downloading(_ progress: PanoDownloadProgress) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("\(progress.fileName) (\(progress.fileIndex + 1) of \(progress.fileCount))")
          .font(.subheadline)
          .lineLimit(1)
        Spacer()
        Button("Cancel", role: .cancel) { download.cancel() }
          .accessibilityLabel("Cancel the download and remove downloaded frames")
      }
      ProgressView(value: progress.fileFraction)
        .accessibilityLabel("\(progress.fileName): \(Int(progress.fileFraction * 100)) percent")
      ProgressView(value: progress.overallFraction)
        .accessibilityLabel("All frames: \(Int(progress.overallFraction * 100)) percent")
      Text("\(Self.bytes(progress.receivedBytes)) of \(Self.bytes(progress.totalBytes))")
        .font(.caption)
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }
    .padding(.vertical, 4)
  }

  private func warning(_ text: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
      MuiIcon(name: "warning", size: .sm)
        .foregroundStyle(.orange)
        .accessibilityHidden(true)
      Text(text)
        .font(.caption)
    }
    .accessibilityElement(children: .combine)
  }

  private static func bytes(_ count: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: max(count, 0), countStyle: .file)
  }
}
