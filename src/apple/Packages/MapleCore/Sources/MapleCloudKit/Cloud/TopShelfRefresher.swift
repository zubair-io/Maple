// TopShelfRefresher.swift
//
// Fetches what Maple TV's Top Shelf shows and writes it to the shared cache.
//
// Lives in MapleCloudKit rather than in the extension because BOTH processes
// need it, and for different reasons. The app is the reliable filler: it has
// no deadline, so it can take as long as the network does. The extension can
// only fill the cache under a hard time limit — tvOS replaces a slow content
// provider with the static app icon — so on a cold cache it will often fail
// to finish, and the app having already run is what makes the shelf appear
// at all.
//
// Takes clients rather than a session type so either process can call it with
// whatever it already has: the app passes its live `TVCloudSession` clients,
// the extension builds throwaway ones from the shared Keychain.

import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum TopShelfRefresher {
  /// Rebuild the cache from the server. Returns true when it wrote something,
  /// so the caller can decide whether telling tvOS to reload is worth it.
  ///
  /// Memories first; recent photos only when the day produced no memories.
  /// Both paths exclude screenshots and anyone the operator soft-hid — the
  /// memories path inherits that from the server re-deriving its stored query
  /// on every call, the recents path has to ask for it. This is a Home screen
  /// in a living room, visible without anybody choosing to look at it, so a
  /// hidden person must not surface here (the same reasoning
  /// `LightTableViewModel` applies to the Light Table).
  public static func run(
    libraryID: String,
    generatedSearch: GeneratedSearchClient,
    search: CloudSearchClient,
    thumbs: CloudThumbClient,
    cache: TopShelfCache
  ) async -> Bool {
    if let built = await memories(
      libraryID: libraryID, generatedSearch: generatedSearch,
      thumbs: thumbs), !built.entries.isEmpty
    {
      return await write(built, isFallback: false, cache: cache)
    }
    guard let built = await recents(libraryID: libraryID, search: search, thumbs: thumbs),
      !built.entries.isEmpty
    else { return false }
    return await write(built, isFallback: true, cache: cache)
  }

  private struct Built {
    let entries: [TopShelfEntry]
    let images: [String: Data]
  }

  private static func write(_ built: Built, isFallback: Bool, cache: TopShelfCache) async -> Bool {
    guard !built.images.isEmpty else { return false }
    do {
      try await cache.write(entries: built.entries, images: built.images, isFallback: isFallback)
      return true
    } catch {
      // Nothing useful to do with a write failure in an extension: the old
      // cache stands and the next refresh tries again.
      return false
    }
  }

  private static func memories(
    libraryID: String, generatedSearch: GeneratedSearchClient, thumbs: CloudThumbClient
  ) async -> Built? {
    guard let collections = try? await generatedSearch.collections(libraryID: libraryID),
      !collections.isEmpty
    else { return nil }

    // One cover lookup per collection, concurrently — there are a handful a
    // day. Take only as many as the shelf can show before fetching images.
    let candidates = Array(collections.prefix(TopShelfCache.maxEntries))
    let covers = await withTaskGroup(of: (String, SearchAsset?).self) { group in
      for collection in candidates {
        group.addTask { [client = generatedSearch] in
          let page = try? await client.assets(collectionID: collection.id, limit: 1)
          return (collection.id, page?.results.first)
        }
      }
      var found: [String: SearchAsset] = [:]
      for await (id, asset) in group {
        if let asset { found[id] = asset }
      }
      return found
    }

    let entries = TopShelfBuilder.entries(forMemories: candidates, covers: covers)
    guard !entries.isEmpty else { return nil }
    let paths = entries.reduce(into: [String: String]()) { out, entry in
      out[entry.id] = covers[entry.id]?.abs_path
    }
    return Built(entries: entries, images: await images(for: paths, thumbs: thumbs))
  }

  private static func recents(
    libraryID: String, search: CloudSearchClient, thumbs: CloudThumbClient
  ) async -> Built? {
    var params = SearchParams(libraryID: libraryID)
    params.sort = .capturedDesc
    params.isScreenshot = false
    params.excludeHiddenPeople = true

    guard
      let response = try? await search.search(
        params, page: 0, limit: TopShelfCache.maxEntries
      )
    else { return nil }

    let entries = TopShelfBuilder.entries(forRecents: response.results)
    guard !entries.isEmpty else { return nil }
    let paths = response.results.reduce(into: [String: String]()) { out, asset in
      out[asset.id] = asset.abs_path
    }
    return Built(entries: entries, images: await images(for: paths, thumbs: thumbs))
  }

  /// Normalize server previews (including AVIF) to the cached JPEG format.
  static func jpeg(_ data: Data) -> Data? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return nil }
    let output = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        output, UTType.jpeg.identifier as CFString, 1, nil
      )
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return output as Data
  }

  /// Fetch each entry's cover at the `.preview` tier. `.thumb` is 512px on
  /// the long edge, far too small for a full-bleed hero; `.preview` is ~1280,
  /// which is still under 1080p but is the largest tier the server offers.
  private static func images(
    for pathsByID: [String: String],
    thumbs: CloudThumbClient
  ) async -> [String: Data] {
    await withTaskGroup(of: (String, Data?).self) { group in
      for (id, path) in pathsByID {
        group.addTask { [client = thumbs] in
          let data = try? await client.preview(absPath: path)
          return (id, data.flatMap(jpeg))
        }
      }
      var out: [String: Data] = [:]
      for await (id, data) in group {
        if let data { out[id] = data }
      }
      return out
    }
  }
}
