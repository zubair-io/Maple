// MuiQrCode.swift — Maple UI QR Code atom.
// Contract: docs/design/maple-ui/components/qr-code.md

import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins

public enum MuiQrCodeSize: Sendable {
    case sm, md, lg

    var points: CGFloat {
        switch self {
        case .sm: return 96
        case .md: return 128
        case .lg: return 192
        }
    }
}

/// Renders a text payload as a scannable QR code, using CoreImage's
/// `CIQRCodeGenerator` — no third-party dependency needed on Apple
/// (qr-code.md §Purpose).
public struct MuiQrCode: View {
    public let value: String
    public let size: MuiQrCodeSize
    public let ariaLabel: String?

    public init(value: String, size: MuiQrCodeSize = .md, ariaLabel: String? = nil) {
        self.value = value
        self.size = size
        self.ariaLabel = ariaLabel
    }

    public var body: some View {
        Group {
            if let cgImage = Self.generateCGImage(value: value, pixelSize: size.points) {
                Image(cgImage, scale: 1, label: Text(ariaLabel ?? "QR code for \(value)"))
                    .interpolation(.none)
                    .resizable()
                    .frame(width: size.points, height: size.points)
                    .clipShape(RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
            } else {
                Text("Can't generate a QR code for this payload")
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.errorText)
                    .frame(width: size.points, height: size.points)
            }
        }
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel(ariaLabel ?? "QR code for \(value)")
    }

    /// Encodes `value` as a QR code and rasterizes it at `pixelSize`,
    /// black-on-white with a 4-module quiet zone (qr-code.md §Tokens used /
    /// §Accessibility — a camera scanner needs maximum contrast and a
    /// clear border to lock on, regardless of the app's dark theme). Public
    /// + static so a payload can be asserted non-nil without rendering a
    /// view.
    public static func generateCGImage(value: String, pixelSize: CGFloat) -> CGImage? {
        guard !value.isEmpty, pixelSize > 0 else { return nil }
        guard let data = value.data(using: .utf8) else { return nil }

        let filter = CIFilter.qrCodeGenerator()
        filter.message = data
        filter.correctionLevel = "M"
        guard let qrImage = filter.outputImage else { return nil }

        let quietZoneModules: CGFloat = 4
        let paddedExtent = qrImage.extent.insetBy(dx: -quietZoneModules, dy: -quietZoneModules)
        let whiteBackground = CIImage(color: .white).cropped(to: paddedExtent)
        let composed = qrImage.composited(over: whiteBackground)

        let scale = pixelSize / paddedExtent.width
        let transformed = composed.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        let context = CIContext()
        return context.createCGImage(transformed, from: transformed.extent)
    }
}

#Preview("MuiQrCode — Sizes") {
    HStack(alignment: .bottom, spacing: 16) {
        MuiQrCode(value: "https://maple.app/pair/abc123", size: .sm)
        MuiQrCode(value: "https://maple.app/pair/abc123", size: .md)
        MuiQrCode(value: "https://maple.app/pair/abc123", size: .lg)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiQrCode — Error") {
    MuiQrCode(value: "")
        .padding()
        .background(MuiTokens.bg)
}
