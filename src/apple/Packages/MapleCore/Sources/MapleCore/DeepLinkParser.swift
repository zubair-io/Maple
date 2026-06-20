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
    ///
    /// `.image` ids are single path components (UUIDs / opaque hex) so
    /// only the first component after the host is read; extra components
    /// are ignored (future subpath extensions, spec §1).
    ///
    /// `.source` ids may contain `/` — a local folder path
    /// (`/Users/alice/Photos`), an SMB share (`alice@nas/Photos` or
    /// `nas/Photos`), or a PhotoKit localIdentifier. All trailing
    /// path components after the host are joined back with `/` to
    /// reconstruct the original id.
    public static func parse(_ url: URL) -> DeepLinkDestination? {
        guard url.scheme == "maple" else { return nil }
        // SwiftUI delivers `maple://host/path` with `host` carrying
        // the destination kind and path components carrying the id.
        // `pathComponents` includes a leading "/" — `dropFirst()` removes
        // it before reading the id components.
        let components = url.pathComponents.dropFirst()
        guard let firstComponent = components.first, !firstComponent.isEmpty else {
            return nil
        }
        switch url.host {
        case "image":
            // Single-component id — extra sub-path ignored per spec §1.
            return .image(id: firstComponent)
        case "source":
            // Rejoin all path components so slash-bearing ids (folder paths,
            // SMB `host/share`, `user@host/share`) survive the URL round-trip.
            // Callers must percent-encode `/` inside the id so Foundation's
            // URL parser doesn't split on them; `pathComponents` then
            // percent-decodes each component, restoring the original characters.
            // Example: "source/%2FUsers%2Falice%2FPhotos" →
            //   pathComponents = ["/", "/Users/alice/Photos"]
            //   dropFirst()    = ["/Users/alice/Photos"]
            //   joined         = "/Users/alice/Photos" ✓
            // Example: "source/nas/Photos" →
            //   pathComponents = ["/", "nas", "Photos"]
            //   dropFirst()    = ["nas", "Photos"]
            //   joined         = "nas/Photos" ✓
            let id = url.pathComponents.dropFirst().joined(separator: "/")
            if id.isEmpty { return nil }
            return .source(id: id)
        default:
            return nil
        }
    }
}
