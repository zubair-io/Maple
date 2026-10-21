// VideoCaptureDate.swift — #5001: a video's capture date, read exactly as the
// server's indexer reads it, so a device backing up a .mov/.mp4 derives the
// same primary-form maple_id the server stamps on that file.
//
// Port of `src/api/src/indexer/video-metadata.ts` (`readVideoMetadata` →
// `parseMoov`) plus the `asIsoDate` normalisation in `src/api/src/indexer/
// exif.ts`. The server prefers the `com.apple.quicktime.creationdate` key
// (the last one found under `moov/meta` or `moov/udta/meta`) and falls back to
// `mvhd` creation_time, then hashes `new Date(value).toISOString()`.

import Foundation

public enum VideoCaptureDate {
  /// ISO 8601 UTC with milliseconds (`2026-04-05T18:26:20.000Z`), or nil
  /// when the file has no `moov` box or no usable date. Reads `bytes` in
  /// place: a backup already holds the whole original, and a second copy of
  /// a multi-GB clip risks a jetsam kill.
  public static func iso8601UTC(fromVideoBytes bytes: Data) -> String? {
    guard let moov = children(of: bytes).first(where: { $0.type == "moov" })?.payload
    else { return nil }
    return captureDate(fromMoov: moov)
  }

  private static func captureDate(fromMoov moov: Data) -> String? {
    let boxes = children(of: moov)
    let mvhdDate = boxes.last(where: { $0.type == "mvhd" }).flatMap { mvhdISO($0.payload) }
    let metas = boxes.flatMap { box -> [Data] in
      switch box.type {
      case "meta": return [box.payload]
      case "udta": return children(of: box.payload).filter { $0.type == "meta" }.map(\.payload)
      default: return []
      }
    }
    // The last meta carrying the key decides, as `keysDate = …` does on
    // the server.
    switch metas.compactMap(creationDateKey(inMeta:)).last {
    case .date(let iso): return iso
    case .cleared, nil: return mvhdDate
    }
  }

  // MARK: - Boxes

  private struct Box {
    let type: String
    let typeCode: UInt32
    let payload: Data
  }

  private static func u32(_ data: Data, _ offset: Int) -> UInt32 {
    let i = data.startIndex + offset
    return UInt32(data[i]) << 24 | UInt32(data[i + 1]) << 16 | UInt32(data[i + 2]) << 8
      | UInt32(data[i + 3])
  }

  private static func u64(_ data: Data, _ offset: Int) -> UInt64 {
    UInt64(u32(data, offset)) << 32 | UInt64(u32(data, offset + 4))
  }

  /// One box header at `offset`, or nil when it is truncated or declares a
  /// size the container cannot hold — the server's `readBoxHeader`.
  private static func boxHeader(_ data: Data, at offset: Int)
    -> (size: Int, headerLength: Int)?
  {
    let remaining = data.count - offset
    guard remaining >= 8 else { return nil }
    let declared = u32(data, offset)
    let (size, headerLength): (UInt64, Int)
    switch declared {
    case 1:
      guard remaining >= 16 else { return nil }
      (size, headerLength) = (u64(data, offset + 8), 16)
    case 0:
      (size, headerLength) = (UInt64(remaining), 8)
    default:
      (size, headerLength) = (UInt64(declared), 8)
    }
    // Compared without adding to `offset`: a hostile 64-bit size must be
    // rejected, not overflow.
    guard size >= UInt64(headerLength), size <= UInt64(remaining) else { return nil }
    return (Int(size), headerLength)
  }

  /// Child boxes of `data[start...]` in order, stopping at the first
  /// malformed header — the server's `walkBoxes`.
  private static func children(of data: Data, from start: Int = 0) -> [Box] {
    var boxes: [Box] = []
    var offset = start
    while let header = boxHeader(data, at: offset) {
      let base = data.startIndex + offset
      boxes.append(
        Box(
          type: String(decoding: data[base + 4..<base + 8], as: UTF8.self),
          typeCode: u32(data, offset + 4),
          payload: data[base + header.headerLength..<base + header.size]))
      offset += header.size
    }
    return boxes
  }

  // MARK: - mvhd and keys/ilst

  /// Seconds between the QuickTime epoch (1904-01-01) and the Unix epoch.
  private static let quickTimeEpochOffset: UInt64 = 2_082_844_800

  private static func mvhdISO(_ payload: Data) -> String? {
    guard payload.count >= 8 else { return nil }
    let version = payload[payload.startIndex]
    guard version != 1 || payload.count >= 12 else { return nil }
    let seconds = version == 1 ? u64(payload, 4) : UInt64(u32(payload, 4))
    // Past year 9999 the server's `toISOString` throws or widens the year;
    // only sane timestamps get a date.
    guard seconds > quickTimeEpochOffset, seconds - quickTimeEpochOffset <= 253_402_300_799
    else { return nil }
    return utcISO(
      Date(timeIntervalSince1970: TimeInterval(seconds - quickTimeEpochOffset)), millis: "000")
  }

  private enum KeyDate {
    /// The server and the device read this value to the same instant.
    case date(String)
    /// Any other value: the device falls back to `mvhd`. Where JavaScript
    /// rejects it (no ASCII digit, full-width digits, an out-of-range offset)
    /// the server's `normalizeCreationDate` yields null and it falls back to
    /// `mvhd` too. Where JavaScript reads it in a way Swift cannot reproduce
    /// (offset-less in the server's own zone, loose formats, a year past
    /// 9999) the dates differ whatever the device does (#5092 review).
    /// Distinct from no key: a later meta's unusable value overrides an
    /// earlier meta's date, because the server's `keysDate` assignment does.
    case cleared
  }

  /// nil when this meta carries no creationdate value.
  private static func creationDateKey(inMeta meta: Data) -> KeyDate? {
    let boxes = children(of: meta, from: metaChildrenStart(meta))
    let names = boxes.last(where: { $0.type == "keys" }).map { keyNames($0.payload) } ?? []
    guard let ilst = boxes.last(where: { $0.type == "ilst" })?.payload, !names.isEmpty
    else { return nil }
    // An `ilst` child's box type is its 1-based index into the key names.
    let value = children(of: ilst)
      .filter { item in
        let index = Int(item.typeCode)
        return index >= 1 && index <= names.count
          && names[index - 1] == "com.apple.quicktime.creationdate"
      }
      .flatMap { children(of: $0.payload) }
      .last(where: { $0.type == "data" && $0.payload.count >= 8 })
      .map { $0.payload.dropFirst(8) }
    guard let value else { return nil }
    return keyDate(String(decoding: value, as: UTF8.self))
  }

  private static func keyNames(_ payload: Data) -> [String] {
    guard payload.count >= 8 else { return [] }
    let count = Int(u32(payload, 4))
    var names: [String] = []
    var offset = 8
    while names.count < count, payload.count - offset >= 8 {
      let size = Int(u32(payload, offset))
      guard size >= 8, size <= payload.count - offset else { break }
      let start = payload.startIndex + offset
      names.append(String(decoding: payload[start + 8..<start + size], as: UTF8.self))
      offset += size
    }
    return names
  }

  /// `meta` is a FullBox in ISO-MP4 but a plain box in QuickTime.
  private static func metaChildrenStart(_ meta: Data) -> Int {
    let base = meta.startIndex
    let tagAt = { (offset: Int) -> String? in
      meta.count >= offset + 4
        ? String(decoding: meta[base + offset..<base + offset + 4], as: UTF8.self) : nil
    }
    if tagAt(4) == "hdlr" { return 0 }
    if tagAt(8) == "hdlr" { return 4 }
    return 0
  }

  // MARK: - Dates, as the server's JavaScript reads them

  /// The one shape both runtimes read identically: an ASCII ISO 8601 instant
  /// with whole seconds, an optional fraction, and `Z` or a `±HH:MM` offset
  /// (after the server's `±HHMM` → `±HH:MM` fix-up). Years from 1900:
  /// Foundation switches to the Julian calendar before 1582, JavaScript
  /// never does. `\z`, not `$`, which also matches before a trailing U+0085
  /// that JavaScript's `Date` rejects.
  private static let strictInstant = try! NSRegularExpression(
    pattern:
      #"^((?:19|[2-9][0-9])[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]+))?(?:Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))\z"#
  )

  private static let utc = TimeZone(identifier: "UTC")!

  private static let gregorianUTC: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = utc
    return calendar
  }()

  private static func keyDate(_ raw: String) -> KeyDate {
    // JavaScript's `trim()` and Swift's whitespace set differ (U+0085,
    // U+FEFF); anything outside plain ASCII whitespace is left in place for
    // the strict pattern to reject.
    let trimmed = raw.trimmingCharacters(in: CharacterSet(charactersIn: " \t\n\r"))
    let normalized = trimmed.replacingOccurrences(
      of: #"([+-][0-9]{2})([0-9]{2})\z"#, with: "$1:$2", options: .regularExpression)
    let ns = normalized as NSString
    guard
      let match = strictInstant.firstMatch(
        in: normalized, range: NSRange(location: 0, length: ns.length))
    else { return .cleared }
    let text = { (index: Int) -> String? in
      let range = match.range(at: index)
      return range.location == NSNotFound ? nil : ns.substring(with: range)
    }
    let number = { (index: Int) -> Int in text(index).flatMap { Int($0) } ?? 0 }
    let offsetSeconds =
      (text(8) == "-" ? -1 : 1) * (number(9) * 3600 + number(10) * 60)
    // A day past the month's end (2023-02-29) rolls into the next month in
    // JavaScript; Calendar's lenient components do the same.
    guard
      let local = gregorianUTC.date(
        from: DateComponents(
          year: number(1), month: number(2), day: number(3),
          hour: number(4), minute: number(5), second: number(6)))
    else { return .cleared }
    // `toISOString` keeps the first three fraction digits; never round-trip
    // them through a Double.
    let millis = String((text(7) ?? "").prefix(3))
      .padding(toLength: 3, withPad: "0", startingAt: 0)
    let instant = local.addingTimeInterval(TimeInterval(-offsetSeconds))
    // An offset can carry 9999-12-31 into year 10000, which `toISOString`
    // writes as `+010000`.
    guard gregorianUTC.component(.year, from: instant) <= 9999 else { return .cleared }
    return .date(utcISO(instant, millis: millis))
  }

  private static let utcSeconds: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = utc
    return formatter
  }()

  /// `Date.prototype.toISOString` for a whole-second instant plus three
  /// millisecond digits.
  private static func utcISO(_ date: Date, millis: String) -> String {
    "\(utcSeconds.string(from: date).dropLast()).\(millis)Z"
  }
}
