import Foundation

/// Where a `maple-tv://` URL wants to land.
public enum TVDeepLink: Equatable, Sendable {
  /// `maple-tv://memories` — the Memories screen itself. Also where an
  /// unrecognised `maple-tv://` URL lands, since every link this app
  /// currently emits is about memories and opening the wrong screen beats
  /// opening none.
  case memories
  /// `maple-tv://memory/<collection-id>` — one memory's grid.
  case memory(id: String)

  public init?(url: URL) {
    guard url.scheme == "maple-tv" else { return nil }
    // Both `maple-tv://memory/<id>` and `maple-tv:///memory/<id>` parse: the
    // first puts "memory" in the host, the second in the path. Accepting both
    // costs one line and avoids a link that silently does nothing.
    let segments = ([url.host].compactMap { $0 } + url.pathComponents)
      .filter { $0 != "/" && !$0.isEmpty }
    guard segments.first == "memory", segments.count == 2, !segments[1].isEmpty else {
      self = .memories
      return
    }
    self = .memory(id: segments[1])
  }
  public var url: URL {
    switch self {
    case .memories:
      return URL(string: "maple-tv://memories")!
    case .memory(let id):
      var components = URLComponents()
      components.scheme = "maple-tv"
      components.host = "memory"
      let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
      components.percentEncodedPath =
        "/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
      return components.url ?? URL(string: "maple-tv://memories")!
    }
  }
}
