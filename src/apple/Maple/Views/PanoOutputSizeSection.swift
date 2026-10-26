// PanoOutputSizeSection.swift — Full resolution / Smaller choice in
// PanoMergeView on devices with a per-process memory limit (#5454).
//
// Shown only once a preview has reported the full stitch's size and the
// platform reports a memory limit (iPhone, iPad). macOS never shows it and
// always stitches at full resolution. The session picks "Smaller" by
// default when full resolution would not fit; the user can override it.

import MapleCore
import SwiftUI

struct PanoOutputSizeSection: View {
  let session: PanoMergeSession

  var body: some View {
    if let fit = session.memoryFit, let sizes = session.lastPreview?.stitchSizes {
      Section {
        if case .fitted(_, _, let width, let height) = fit {
          Picker(
            "Output Size",
            selection: Binding(
              get: { session.outputSize },
              set: { session.outputSize = $0 }
            )
          ) {
            Text("Full resolution, \(dimensions(sizes.canvasWidth, sizes.canvasHeight))")
              .tag(PanoOutputSize.full)
            Text("Smaller (fits this device), \(dimensions(width, height))")
              .tag(PanoOutputSize.fitted)
          }
          .disabled(session.isRunning)
          .accessibilityLabel("Panorama output size")
        } else {
          LabeledContent("Output Size") {
            Text("Full resolution, \(dimensions(sizes.canvasWidth, sizes.canvasHeight))")
          }
        }

        Text(explanation(fit))
          .font(.caption)
          .foregroundStyle(.secondary)
      } header: {
        Text("Output")
      }
    }
  }

  private func explanation(_ fit: PanoMemoryFit) -> String {
    switch fit {
    case .fullFits(let bytes):
      return "Full resolution needs about \(gigabytes(bytes)) and fits in this device's memory."
    case .fitted(let fullBytes, _, _, _):
      let need =
        "Full resolution needs about \(gigabytes(fullBytes)), more than this device has free."
      return session.outputSize == .full
        ? need + " The stitch may be stopped by the system."
        : need + " The smaller size fits."
    case .tooLarge(let fullBytes):
      return "These frames need about \(gigabytes(fullBytes)) even at a smaller size, "
        + "more than this device has free. Stitch on a Mac, or with fewer frames."
    }
  }

  private func dimensions(_ width: Int, _ height: Int) -> String {
    "\(width.formatted()) × \(height.formatted())"
  }

  private func gigabytes(_ bytes: Int) -> String {
    Measurement(value: Double(bytes), unit: UnitInformationStorage.bytes)
      .converted(to: .gigabytes)
      .formatted(
        .measurement(
          width: .abbreviated, usage: .asProvided,
          numberFormatStyle: .number.precision(.fractionLength(1))))
  }
}
