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
        // the destination kind and the first non-root path component
        // carrying the id. `pathComponents` includes a leading "/" —
        // `dropFirst()` removes it before reading the id.
        guard let id = url.pathComponents.dropFirst().first, !id.isEmpty else {
            return nil
        }
        switch url.host {
        case "image":
            return .image(id: id)
        case "source":
            return .source(id: id)
        default:
            return nil
        }
    }
}
