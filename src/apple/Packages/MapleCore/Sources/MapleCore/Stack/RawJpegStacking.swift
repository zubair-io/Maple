import Foundation

/// Folds each RAW+JPEG pair of a listing into the RAW's one tile (#5050). The JPEG leaves the list
/// and rides on the RAW as `AssetRef.stack`, so every action on the tile reaches both files.
public enum RawJpegStacking {
  /// Local-folder refs for `urls`. With `stacksPairs` off every file is its own tile.
  static func localRefs(
    _ urls: [URL], scopeParentURL: URL?, livePhotoLinks: [String: LivePhotoLink],
    stacksPairs: Bool
  ) -> [AssetRef] {
    let pairs = stacksPairs ? RawJpegPairing.pairs(in: urls.map(\.path)) : [:]
    let companions = Set(pairs.values)
    let urlByPath = Dictionary(urls.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    return urls.filter { !companions.contains($0.path) }.map { url in
      let jpeg = pairs[url.path].flatMap { urlByPath[$0] }
      let stack = jpeg.map { jpeg in
        RawJpegStack(
          primary: .init(name: url.lastPathComponent, size: fileSize(url)),
          companion: .init(name: jpeg.lastPathComponent, size: fileSize(jpeg)),
          location: .local(jpeg))
      }
      // A Live Photo still is the JPEG half; the tile keeps its link (#5050).
      return AssetRef(
        url: url, scopeParentURL: scopeParentURL,
        livePhoto: livePhotoLinks[url.path] ?? jpeg.flatMap { livePhotoLinks[$0.path] },
        stack: stack)
    }
  }

  /// The Live Photo link a stacked SMB tile carries: its own, or its JPEG half's (#5050).
  static func smbLivePhoto(
    rawPath: String?, stack: RawJpegStack?, links: [String: LivePhotoLink]
  ) -> LivePhotoLink? {
    rawPath.flatMap { links[$0] } ?? stack?.smbCompanionRef?.smbPath.flatMap { links[$0] }
  }

  /// The SMB listing folded the same way: the refs that stay tiles, and the stack each RAW ref
  /// carries, keyed by the RAW's share path. `sizes` are the sizes the directory listing reported.
  static func smbFold(
    _ refs: [ImageRef], sizes: [String: Int64], stacksPairs: Bool
  ) -> (tiles: [ImageRef], stacks: [String: RawJpegStack]) {
    guard stacksPairs else { return (refs, [:]) }
    let refByPath = Dictionary(
      refs.compactMap { ref in ref.smbPath.map { ($0, ref) } },
      uniquingKeysWith: { first, _ in first })
    let pairs = RawJpegPairing.pairs(in: Array(refByPath.keys))
    let companions = Set(pairs.values)
    let stacks = Dictionary(
      uniqueKeysWithValues: pairs.compactMap { rawPath, jpegPath -> (String, RawJpegStack)? in
        guard let raw = refByPath[rawPath], let jpeg = refByPath[jpegPath] else { return nil }
        return (
          rawPath,
          RawJpegStack(
            primary: .init(name: raw.displayName, size: sizes[rawPath]),
            companion: .init(name: jpeg.displayName, size: sizes[jpegPath]),
            location: .smb(jpeg))
        )
      })
    return (refs.filter { $0.smbPath.map(companions.contains) != true }, stacks)
  }

  /// The stack the Self Hosted listing reported on a RAW entry.
  public static func cloudStack(for entry: FsImageEntry) -> RawJpegStack? {
    entry.stack.map { stack in
      RawJpegStack(
        primary: .init(name: entry.name, size: entry.size),
        companion: .init(name: stack.companion.name, size: stack.companion.size),
        location: .cloud(
          address: stack.companion.address, path: stack.companion.path, id: stack.companion.id))
    }
  }

  /// The stack a Self Hosted timeline or search hit reported on a RAW (#5849). A companion with
  /// no address (its library has no slug) is left off, as on Web, since a cloud stack locates its
  /// JPEG by address.
  public static func cloudStack(for asset: SearchAsset) -> RawJpegStack? {
    guard let companion = asset.stack?.companion, let address = companion.address else {
      return nil
    }
    return RawJpegStack(
      primary: .init(name: asset.filename, size: asset.size),
      companion: .init(name: companion.name, size: companion.size),
      location: .cloud(address: address, path: companion.path, id: companion.id))
  }

  private static func fileSize(_ url: URL) -> Int64? {
    (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init)
  }
}
