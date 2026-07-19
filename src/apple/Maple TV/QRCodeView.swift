// src/apple/Maple TV/QRCodeView.swift
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Renders a QR code for `string` via CoreImage's `CIFilter.qrCodeGenerator`.
/// QR generation produces a tiny bitmap (one pixel per module) that then
/// needs to be scaled up to a comfortable on-screen size — `.interpolation(.none)`
/// is load-bearing here, not cosmetic: the default `.medium` interpolation
/// blurs module edges into gray, which both looks wrong and can make a
/// phone camera fail to decode the code.
struct QRCodeView: View {
  let string: String

  private static let context = CIContext()

  var body: some View {
    Group {
      if let cgImage = Self.render(string) {
        Image(decorative: cgImage, scale: 1)
          .interpolation(.none)
          .resizable()
          .aspectRatio(1, contentMode: .fit)
      } else {
        // Rendering only fails for a string too long for a QR symbol at
        // this correction level, which never happens for our fixed-shape
        // base64url payload — this is a defensive fallback, not a real
        // code path, so it stays a plain empty surface rather than
        // growing its own error UI.
        MapleTVTheme.surface
      }
    }
  }

  private static func render(_ string: String) -> CGImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(string.utf8)
    filter.correctionLevel = "M"
    guard let outputImage = filter.outputImage else { return nil }
    return context.createCGImage(outputImage, from: outputImage.extent)
  }
}
