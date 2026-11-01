// PanoPreviewSection.swift — The automatic low-resolution panorama preview in
// PanoMergeView (#4579).
//
// The preview starts as soon as the sheet opens with two or more frames and
// re-runs (debounced, in PanoMergeSession) when an option changes. A fresh
// preview of a 21-frame set takes minutes, not milliseconds, so it always
// shows staged progress and keeps the previous image visible underneath.

import MapleCore
import MapleUI
import SwiftUI

struct PanoPreviewSection: View {
  let session: PanoMergeSession
  let onRetry: () -> Void
  var onOpenPanoSettings: (() -> Void)? = nil

  var body: some View {
    Section {
      if let preview = session.lastPreview {
        previewImage(preview)
        PanoMatcherNote(matcher: preview.matcher, onOpenPanoSettings: onOpenPanoSettings)
      }
      status
    } header: {
      Text("Preview")
    } footer: {
      if let preview = session.lastPreview, !session.isPreviewing {
        Text(preview.alignmentOutcome.summary + " Create Panorama starts from this alignment.")
      }
    }
  }

  private func previewImage(_ preview: PanoPreview) -> some View {
    Image(decorative: preview.image, scale: 1)
      .resizable()
      .aspectRatio(contentMode: .fit)
      .frame(maxWidth: .infinity, maxHeight: 280)
      .clipShape(RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
      .opacity(session.isPreviewing ? 0.45 : 1)
      .animation(.easeInOut(duration: 0.2), value: session.isPreviewing)
      .accessibilityElement()
      .accessibilityAddTraits(.isImage)
      .accessibilityLabel(
        session.isPreviewing
          ? "Previous panorama preview, updating"
          : "Panorama preview, \(preview.image.width) by \(preview.image.height) pixels")
  }

  @ViewBuilder
  private var status: some View {
    switch session.previewState {
    case .idle:
      EmptyView()
    case .scheduled:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text(session.previewIsEdgesOnly ? "Updating edges…" : "Updating preview…")
          .font(.subheadline)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(
        session.previewIsEdgesOnly
          ? "Panorama edges update scheduled" : "Panorama preview update scheduled")
    case .running(let stage, let overall):
      if session.previewIsEdgesOnly {
        edgesProgress(overall: overall)
      } else {
        progress(stage: stage, overall: overall)
      }
    case .ready:
      EmptyView()
    case .failed(let error):
      failure(error)
    }
  }

  private func edgesProgress(overall: Double) -> some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.small)
      Text("Updating edges…").font(.subheadline)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Updating panorama edges")
  }

  private func progress(stage: PanoStage, overall: Double) -> some View {
    let percent = Int((overall * 100).rounded())
    return VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Building preview — \(stage.displayName)")
          .font(.subheadline)
        Spacer()
        Text("\(percent)%")
          .font(.caption)
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
      ProgressView(value: overall)
        .progressViewStyle(.linear)
      Text(
        "Matching a large set can take a few minutes. You can change options or create the panorama at any time."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Building panorama preview, \(stage.displayName), \(percent) percent")
  }

  @ViewBuilder
  private func failure(_ error: PanoMergeSession.StitchError) -> some View {
    HStack(alignment: .top, spacing: 10) {
      MuiIcon(name: "warning", size: .sm, filled: true)
        .foregroundStyle(.red)
        .imageScale(.large)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text("Preview failed")
          .font(.subheadline.weight(.medium))
        Text(error.message)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Panorama preview failed: \(error.message)")

    Button("Retry Preview", action: onRetry)
      .disabled(session.isRunning)
      .accessibilityLabel("Build the panorama preview again")
  }
}
