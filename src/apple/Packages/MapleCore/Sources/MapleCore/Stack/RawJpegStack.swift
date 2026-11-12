import Foundation

/// The two files behind one stacked Library tile: a RAW and the same-stem JPEG (#5050). The RAW is
/// the primary: it keeps the tile's identity, and export reads it. The JPEG is the companion, which
/// follows the RAW through move, rename and trash.
public struct RawJpegStack: Hashable, Sendable {
  /// One of the two files, as Info lists it.
  public struct File: Hashable, Sendable {
    public let name: String
    public let size: Int64?

    public init(name: String, size: Int64?) {
      self.name = name
      self.size = size
    }

    public var fileExtension: String { (name as NSString).pathExtension.lowercased() }
  }

  /// Where the companion lives, in the vocabulary of the source that listed it.
  public enum Location: Hashable, Sendable {
    case local(URL)
    case smb(ImageRef)
    /// `id` is nil until the server has indexed the companion.
    case cloud(address: String, path: String, id: String?)
  }

  public let primary: File
  public let companion: File
  public let location: Location

  public init(primary: File, companion: File, location: Location) {
    self.primary = primary
    self.companion = companion
    self.location = location
  }

  public var localCompanionURL: URL? {
    if case .local(let url) = location { return url }
    return nil
  }

  public var smbCompanionRef: ImageRef? {
    if case .smb(let ref) = location { return ref }
    return nil
  }

  /// The companion's name once the RAW is renamed to `primaryFilename`: the new stem with the
  /// companion's own extension, so `IMG_1.CR3` -> `Trip.CR3` takes `IMG_1.JPG` to `Trip.JPG`.
  public func companionFilename(forPrimaryFilename primaryFilename: String) -> String {
    let stem = (primaryFilename as NSString).deletingPathExtension
    let ext = (companion.name as NSString).pathExtension
    return ext.isEmpty ? stem : "\(stem).\(ext)"
  }

  /// One line of the Info pane's file list.
  public struct InfoRow: Hashable, Sendable {
    public let name: String
    public let type: String
    public let size: String?
    public let isPrimary: Bool
  }

  /// The two files as Info lists them, the RAW first and marked primary.
  public var infoRows: [InfoRow] {
    [
      InfoRow(
        name: primary.name, type: "RAW (\(primary.fileExtension.uppercased()))",
        size: Self.sizeText(primary.size), isPrimary: true),
      InfoRow(
        name: companion.name, type: "JPEG", size: Self.sizeText(companion.size),
        isPrimary: false),
    ]
  }

  private static func sizeText(_ bytes: Int64?) -> String? {
    bytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) }
  }

  /// This stack once its files sit at new names and a new companion location.
  public func relocated(primaryName: String, companionName: String, location: Location)
    -> RawJpegStack
  {
    RawJpegStack(
      primary: File(name: primaryName, size: primary.size),
      companion: File(name: companionName, size: companion.size),
      location: location)
  }
}

extension AssetRef {
  /// The stacked JPEG as its own file for drag-out to Finder, so a dragged tile hands over both
  /// files (#5050). Local folders only: SMB and server companions have no original writer here.
  public var stackCompanionDragAsset: AssetRef? {
    stack?.localCompanionURL.map { AssetRef(url: $0, scopeParentURL: scopeParentURL) }
  }
}

/// The Settings control 'Show one image for RAW+JPEG pairs' for local folders and SMB shares. On by
/// default; with it off both files show as separate tiles. Server libraries keep the same switch in
/// `stack_raw_jpeg` on `/api/display/config`.
public enum RawJpegStackPreference {
  public static let defaultsKey = "stackRawJpegPairs"

  /// Posted after either switch (local or server) changes, so the open grid reloads.
  public static let didChange = Notification.Name("app.justmaple.stackRawJpegPairsDidChange")

  public static func isEnabled(in defaults: UserDefaults = .standard) -> Bool {
    defaults.object(forKey: defaultsKey) == nil || defaults.bool(forKey: defaultsKey)
  }
}
