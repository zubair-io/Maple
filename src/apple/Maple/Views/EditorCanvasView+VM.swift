// Pure download label formatting for EditorCanvasView (pattern #192).

import Foundation

enum EditorCanvasViewVM {
  /// Adaptive byte units, with the total omitted when it is unknown.
  static func downloadByteCountText(receivedBytes: Int64, expectedBytes: Int64?) -> String {
    let style = ByteCountFormatStyle(style: .file)
    let received = receivedBytes.formatted(style)
    if let total = expectedBytes, total > 0 {
      return "\(received) / \(total.formatted(style))"
    }
    return received
  }

  /// The view adds the rate suffix. Clamp invalid or unrepresentable rates
  /// before converting to Int64 so malformed progress cannot crash the view.
  static func downloadSpeedText(_ bytesPerSecond: Double) -> String {
    let clamped: Int64
    if bytesPerSecond.isNaN || bytesPerSecond <= 0 {
      clamped = 0
    } else if bytesPerSecond >= Double(Int64.max) {
      clamped = .max
    } else {
      clamped = Int64(bytesPerSecond)
    }
    return clamped.formatted(ByteCountFormatStyle(style: .file))
  }
}
