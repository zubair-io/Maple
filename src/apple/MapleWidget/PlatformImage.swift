// PlatformImage.swift
//
// The widget runs on iOS/iPadOS (UIKit) and macOS (AppKit), and `Image` takes
// a different initializer on each. This is the one place that difference is
// spelled out, so the view code stays platform-agnostic.

import SwiftUI

#if canImport(UIKit)
  import UIKit
  typealias PlatformImage = UIImage
#elseif canImport(AppKit)
  import AppKit
  typealias PlatformImage = NSImage
#endif

extension Image {
  init(platformImage: PlatformImage) {
    #if canImport(UIKit)
      self.init(uiImage: platformImage)
    #elseif canImport(AppKit)
      self.init(nsImage: platformImage)
    #endif
  }
}
