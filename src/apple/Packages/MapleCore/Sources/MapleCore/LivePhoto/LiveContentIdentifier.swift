import Foundation

/// Apple's Live Photo content identifier of a still or clip, read from metadata only: the still's
/// MakerNote tag `0x0011` (JPEG Exif APP1, or the HEIF `Exif` item) and the clip's `mdta` key
/// `com.apple.quicktime.content.identifier`. The Swift counterpart of the indexer's
/// `readLiveContentId` (`indexer/live-photo/content-id.ts`, #5448).
public enum LiveContentIdentifier {
  /// `length` bytes of the file at `offset`. A short or failed read leaves the file without an identifier.
  public typealias Fetch = @Sendable (_ offset: UInt64, _ length: Int) async throws -> Data

  /// The identifier of the file `size` bytes long that `fetch` reads, upper-cased, or nil when
  /// the file carries none: a photo from another camera, an edited export, a clip that is just
  /// a video. Reads headers, the Exif block or the QuickTime key table, at most 8 MB.
  public static func read(
    kind: LivePhotoPairing.Kind, size: UInt64, fetch: @escaping Fetch
  ) async -> String? {
    guard let source = await LiveByteSource.open(size: size, fetch: fetch) else { return nil }
    let raw =
      switch kind {
      case .clip: await LiveQuickTime.contentIdentifier(source)
      case .still: await stillIdentifier(source)
      }
    guard let token = raw?.trimmingCharacters(in: .whitespacesAndNewlines), isPlausible(token)
    else { return nil }
    return token.uppercased()
  }

  /// The identifier of the local file at `url`, read through a file handle.
  public static func read(fileAt url: URL, kind: LivePhotoPairing.Kind) async -> String? {
    guard let reader = LiveFileReader(url: url) else { return nil }
    return await read(kind: kind, size: reader.size, fetch: reader.fetch)
  }

  /// An identifier is a printable ASCII token of 8 to 64 characters.
  private static func isPlausible(_ token: String) -> Bool {
    (8...64).contains(token.utf8.count) && token.utf8.allSatisfy { (0x21...0x7e).contains($0) }
  }

  private static func stillIdentifier(_ source: LiveByteSource) async -> String? {
    guard let head = await source.read(0, 8) else { return nil }
    let tiff: [UInt8]?
    if head[0] == 0xff, head[1] == 0xd8 {
      tiff = await LiveJpeg.exifBlock(source)
    } else if LiveBinary.latin1(head, 4, 8) == "ftyp" {
      tiff = await LiveHeif.exifTiff(source)
    } else {
      tiff = nil
    }
    return tiff.flatMap(LiveAppleMakerNote.contentIdentifier)
  }
}

/// Positioned reads of one local file. Fetches are serialised by the byte source that drives them.
private final class LiveFileReader: @unchecked Sendable {
  let size: UInt64
  private let handle: FileHandle

  init?(url: URL) {
    guard let handle = try? FileHandle(forReadingFrom: url),
      let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
      values.isRegularFile == true, let size = values.fileSize
    else { return nil }
    self.handle = handle
    self.size = UInt64(size)
  }

  deinit { try? handle.close() }

  var fetch: LiveContentIdentifier.Fetch {
    { [self] offset, length in
      try handle.seek(toOffset: offset)
      return try handle.read(upToCount: length) ?? Data()
    }
  }
}
