// PanoOutputSizeSection.swift — Full resolution / Smaller choice in
// PanoMergeView on devices with a per-process memory limit (#5454), or
// short on storage (#5555).
//
// Shown only once a preview has reported the full stitch's size, and the
// platform reports a memory limit (iPhone, iPad) or the free space is short
// of what full resolution needs. A Mac with room to spare never shows it and
// always stitches at full resolution. The session picks "Smaller" by
// default when full resolution would not fit; the user can override it.

import MapleCore
import SwiftUI

struct PanoOutputSizeSection: View {
  let session: PanoMergeSession

  var body: some View {
    if let sizes = session.lastPreview?.stitchSizes, !explanation.isEmpty {
      Section {
        if let fitted = session.fittedOutput {
          Picker(
            "Output Size",
            selection: Binding(
              get: { session.outputSize },
              set: { session.outputSize = $0 }
            )
          ) {
            Text("Full resolution, \(dimensions(sizes.canvasWidth, sizes.canvasHeight))")
              .tag(PanoOutputSize.full)
            Text("Smaller (fits this device), \(dimensions(fitted.width, fitted.height))")
              .tag(PanoOutputSize.fitted)
          }
          .disabled(session.isRunning)
          .accessibilityLabel("Panorama output size")
        } else {
          LabeledContent("Output Size") {
            Text("Full resolution, \(dimensions(sizes.canvasWidth, sizes.canvasHeight))")
          }
        }

        Text(explanation)
          .font(.caption)
          .foregroundStyle(.secondary)
      } header: {
        Text("Output")
      }
    }
  }

  private var explanation: String {
    [
      session.memoryFit.map(memoryStatement), session.diskFit.flatMap(storageStatement),
      advice,
    ]
    .compactMap { $0 }
    .joined(separator: " ")
  }

  private func memoryStatement(_ fit: PanoMemoryFit) -> String {
    switch fit {
    case .fullFits(let bytes):
      return "Full resolution needs about \(gigabytes(bytes)) of memory, which this device has."
    case .fitted(let fullBytes, _):
      return "Full resolution needs about \(gigabytes(fullBytes)) of memory, "
        + "more than this device has free."
    case .tooLarge(let fullBytes):
      return "These frames need about \(gigabytes(fullBytes)) of memory even at a smaller size, "
        + "more than this device has free."
    }
  }

  private func storageStatement(_ fit: PanoDiskFit) -> String? {
    switch fit {
    case .fullFits:
      return nil
    case .fitted:
      return "Full resolution needs more storage than this device has free."
    case .tooLarge(let shortBytes):
      return "Even a smaller output needs about \(gigabytes(shortBytes)) more free storage "
        + "than this device has."
    }
  }

  /// One closing sentence, so the two statements never each claim the
  /// smaller size fits when only one of them set it.
  private var advice: String? {
    if case .tooLarge = session.memoryFit { return "Stitch on a Mac, or with fewer frames." }
    if case .tooLarge = session.diskFit { return "Free up space, or merge fewer frames." }
    guard session.fittedOutput != nil else { return nil }
    guard session.outputSize == .full else { return "The smaller size fits." }
    if case .fitted = session.memoryFit { return "The system may stop the stitch." }
    return "The merge may run out of storage."
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
