// DeepLinkParser.swift — pure URL parsing for the `maple://` scheme.
//
// The runtime `DeepLinkRouter` lives in the app target (it needs to be
// `@Observable @MainActor` for SwiftUI to react to inbound URLs), but
// the parsing logic is value-typed and platform-independent, so it
// belongs here in MapleCore where `swift test` can cover it without
// the Xcode test-plan plumbing required by the app target's xctest
// bundle.
//
// Destinations:
//   • `maple://image/{id}` → `.image(id:)`
//   • `maple://source/{id}` → `.source(id:)`
//   • `maple://search?…` → `.search(query:)` (widget → seeded search)
//
// Spec: docs/design/responsive-program/deep-links.md §3.
// Closes #624.

import Foundation

public enum DeepLinkDestination: Equatable, Sendable {
    case image(id: String)
    case source(id: String)
    /// `maple://search?placeQuery=…&from=…` — open the cloud search UI
    /// seeded with these raw query pairs (the generated-collection widget
    /// tap). Values are carried verbatim; whitelisting and validation
    /// happen where `SearchParams` is built, so junk in a URL degrades to
    /// an unseeded search rather than a parse failure here.
    case search(query: [String: String])
}

public enum DeepLinkParser {
    /// Parse a `maple://image/{id}` or `maple://source/{id}` URL.
    /// Returns `nil` for any URL that doesn't match — bad input is a
    /// silent no-op upstream, never a thrown error.
    public static func parse(_ url: URL) -> DeepLinkDestination? {
        guard url.scheme == "maple" else { return nil }
        // Matched before the path-length guard below: a search link carries
        // its payload in the query string and has no path at all.
        if url.host == "search" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            var query: [String: String] = [:]
            for item in items {
                if let value = item.value, !value.isEmpty { query[item.name] = value }
            }
            return .search(query: query)
        }
        // SwiftUI delivers `maple://host/path` with `host` carrying
        // the destination kind and the path carrying the id.
        // `url.path` always starts with a leading "/", which we drop.
        let path = url.path
        guard path.count > 1 else { return nil }
        let fullID = String(path.dropFirst())

        switch url.host {
        case "image":
            // For images, we only want the first path component (the id),
            // ignoring any sub-paths like "/edit".
            guard let first = url.pathComponents.dropFirst().first, !first.isEmpty else {
                return nil
            }
            return .image(id: first)
        case "source":
            // For sources, the ID may contain slashes (absolute paths,
            // SMB shares). We preserve the full path.
            return .source(id: fullID)
        default:
            return nil
        }
    }
}
