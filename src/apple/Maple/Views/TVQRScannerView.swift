// TVQRScannerView.swift
//
// Ticket #2082 (Maple TV epic, milestone C, task C4). iOS-only: VisionKit's
// DataScannerViewController has no macOS counterpart, and the "Maple
// Exposure" target's camera entitlement (`ENABLE_RESOURCE_ACCESS_CAMERA`,
// project.pbxproj) is scoped to this flow specifically. PairAppleTVSheet,
// the only caller, is gated the same way.
//
// Two ways in, same downstream payload:
//   1. Point the camera at the TV's QR code — DataScannerViewController
//      recognizes QR-symbology barcodes and hands the raw string to
//      `PairingQRPayload.parse`.
//   2. Paste the code manually, mirroring QRScannerView.swift's paste
//      idiom. This is the ONLY path in the iOS Simulator (no camera
//      hardware) and the fallback whenever camera access is unavailable —
//      DataScannerViewController.isAvailable reflects both "unsupported
//      hardware" and "permission denied", so a false value hides the
//      camera section entirely rather than showing a dead viewfinder.
//
// Neither path trusts its input: PairingQRPayload.parse returns nil (never
// throws) on garbage, so both branches funnel through the same guard.

#if os(iOS)
import SwiftUI
import VisionKit
import MapleCore

struct TVQRScannerView: View {
  /// Fired once with the first payload that parses, from either the
  /// camera or the paste field.
  var onPayload: (PairingQRPayload) -> Void

  @State private var pasted: String = ""
  @State private var pasteError: String? = nil

  private var scannerAvailable: Bool {
    DataScannerViewController.isSupported && DataScannerViewController.isAvailable
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if scannerAvailable {
        DataScannerRepresentable(onPayload: onPayload)
          .frame(minHeight: 260)
          .clipShape(RoundedRectangle(cornerRadius: 12))
          .accessibilityLabel("Camera preview — point it at the Apple TV's pairing QR code")
      } else {
        VStack(spacing: 8) {
          Image(systemName: "qrcode.viewfinder")
            .font(.system(size: 36))
            .foregroundStyle(.secondary)
          Text("Camera scanning isn't available on this device.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 140)
        .accessibilityElement(children: .combine)
      }

      pasteFallback
    }
  }

  private var pasteFallback: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Or paste the pairing code")
        .font(.subheadline.weight(.semibold))
      Text("On the Apple TV, open Settings → Cloud → Pair with iPhone/iPad and copy the code shown below the QR.")
        .font(.caption)
        .foregroundStyle(.secondary)
      TextField("Pairing code", text: $pasted)
        .textFieldStyle(.roundedBorder)
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .accessibilityLabel("Pairing code")
        .accessibilityIdentifier("tv-pairing-code-field")
      if let pasteError {
        Text(pasteError)
          .font(.caption)
          .foregroundStyle(.red)
      }
      Button("Pair") { handlePasted() }
        .buttonStyle(.borderedProminent)
        .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Pair using the pasted code")
    }
  }

  private func handlePasted() {
    let raw = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let payload = PairingQRPayload.parse(raw) else {
      pasteError = "That doesn't look like a valid Apple TV pairing code."
      return
    }
    pasteError = nil
    onPayload(payload)
  }
}

/// Bridges VisionKit's `DataScannerViewController` into SwiftUI, constrained
/// to QR-symbology barcodes only. Recognized strings that don't parse as a
/// `PairingQRPayload` (a stray QR code in frame, an old-format one) are
/// silently ignored — the user just keeps the TV's code in view.
private struct DataScannerRepresentable: UIViewControllerRepresentable {
  var onPayload: (PairingQRPayload) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: false,
      isGuidanceEnabled: true,
      isHighlightingEnabled: true
    )
    controller.delegate = context.coordinator
    try? controller.startScanning()
    return controller
  }

  func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

  static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) {
    uiViewController.stopScanning()
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(onPayload: onPayload)
  }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    private let onPayload: (PairingQRPayload) -> Void
    /// One-shot: the sheet transitions to `.delivering` on the first valid
    /// payload, so any further recognitions while the camera is still live
    /// (or being torn down) must not re-fire the callback.
    private var delivered = false

    init(onPayload: @escaping (PairingQRPayload) -> Void) {
      self.onPayload = onPayload
    }

    func dataScanner(
      _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      guard !delivered else { return }
      for item in addedItems {
        guard case .barcode(let barcode) = item,
          let text = barcode.payloadStringValue,
          let payload = PairingQRPayload.parse(text)
        else { continue }
        delivered = true
        onPayload(payload)
        return
      }
    }
  }
}
#endif
