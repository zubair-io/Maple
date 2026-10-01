/// SSE uses empty lines as event boundaries. Foundation's AsyncBytes.lines
/// omits them, so the File Provider must split the wire bytes itself (#3979).
struct SSELineDecoder {
  private var buffer: [UInt8] = []
  private var previousWasCR = false
  private var firstLine = true

  /// Accept LF, CRLF and CR without losing empty lines or splitting UTF-8.
  mutating func append(_ byte: UInt8) -> String? {
    if byte == 10 && previousWasCR {
      previousWasCR = false
      return nil
    }
    previousWasCR = byte == 13
    guard byte == 10 || byte == 13 else {
      buffer.append(byte)
      return nil
    }
    let decoded = String(decoding: buffer, as: UTF8.self)
    buffer.removeAll(keepingCapacity: true)
    let line =
      firstLine && decoded.hasPrefix("\u{FEFF}")
      ? String(decoded.dropFirst()) : decoded
    firstLine = false
    return line
  }
}
