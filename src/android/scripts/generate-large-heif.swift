// Generate a real 48 MP HEIF for Android's bounded-preview allocation regression.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

precondition(CommandLine.arguments.count == 2, "Pass the output .heic path")
let width = 8000
let height = 6000
let colorSpace = CGColorSpace(name: CGColorSpace.displayP3)!
let context = CGContext(
  data: nil, width: width, height: height, bitsPerComponent: 8,
  bytesPerRow: width * 4, space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
)!
context.setFillColor(CGColor(colorSpace: colorSpace, components: [0.39, 0.59, 0.78, 1])!)
context.fill(CGRect(x: 0, y: 0, width: width, height: height))
let image = context.makeImage()!
let destination = CGImageDestinationCreateWithURL(
  URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL,
  UTType.heic.identifier as CFString, 1, nil
)!
CGImageDestinationAddImage(
  destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary
)
precondition(CGImageDestinationFinalize(destination), "HEIF encode failed")
