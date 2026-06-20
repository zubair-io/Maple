// DeepLinkParser.swift — pure URL parsing for the `maple://` scheme.
//
// The runtime `DeepLinkRouter` lives in the app target (it needs to be
// `@Observable @MainActor` for SwiftUI to react to inbound URLs), but
// the parsing logic is value-typed and platform-independent, so it
// belongs here in MapleCore where `swift test` can cover it without
// the Xcode test-plan plumbing required by the app target's xctest
// bundle.
//
// Two destinations land everything in v0.1:
//   • `maple://image/{id}` → `.image(id:)`
//   • `maple://source/{id}` → `.source(id:)`
//
// Spec: docs/design/responsive-program/deep-links.md §3.
// Closes #624.

import Foundation

public enum DeepLinkDestination: Equatable, Sendable {
    case image(id: String)
    case source(id: String)
}

public enum DeepLinkParser {
    /// Parse a `maple://image/{id}` or `maple://source/{id}` URL.
    /// Returns `nil` for any URL that doesn't match — bad input is a
    /// silent no-op upstream, never a thrown error.
    public static func parse(_ url: URL) -> DeepLinkDestination? {
        guard url.scheme == "maple" else { return nil }
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
