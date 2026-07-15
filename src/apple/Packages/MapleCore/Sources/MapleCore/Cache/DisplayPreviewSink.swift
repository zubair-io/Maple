// DisplayPreviewSink.swift — where the editor persists a developed display
// preview (#2009).
//
// The editor renders to screen per slider tick but persists the AVIF preview
// only on an idle debounce + on exit (see `EditSession+DisplayPreviewPersist`).
// WHERE it lands depends on the asset's backing store, mirroring exactly how
// the XMP sidecar is saved:
//   • local file asset → write the bytes next to the RAW, at
//     `MapleSidecarPaths.previewURL` (`LocalDisplayPreviewSink`);
//   • cloud (Self-Hosted) asset → `PUT /api/preview?path=<original asset path>`
//     so the server overwrites its own copy of the same canonical
//     `<filename>.avif` (`CloudDisplayPreviewSink`), the same save model
//     `CloudSidecarStore` uses for the XMP.
//
// Both take fully-encoded AVIF bytes — the encode (`ThumbnailLoader
// .encodeDisplayPreview`) is shared so a local and a cloud copy are
// byte-identical. Failures are swallowed: a preview is a pure cache, so a
// failed write just leaves the tier to be regenerated on the next read.

import Foundation

/// A destination for a developed display-preview AVIF. `Sendable` so the
/// persister can hand it to a detached encode/upload task.
public protocol DisplayPreviewSink: Sendable {
    /// Persist the already-encoded AVIF `bytes` as this asset's canonical
    /// `<filename>.avif` preview. Best-effort — never throws (a preview is a
    /// pure cache).
    func write(_ bytes: Data) async
}

/// Writes the developed preview to `MapleSidecarPaths.previewURL` next to a
/// local RAW — the on-disk sibling of how `XMPSidecarStore` writes the `.xmp`.
public struct LocalDisplayPreviewSink: DisplayPreviewSink {
    let previewURL: URL

    public init(previewURL: URL) {
        self.previewURL = previewURL
    }

    public func write(_ bytes: Data) async {
        try? FileManager.default.createDirectory(
            at: previewURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try? bytes.write(to: previewURL, options: .atomic)
    }
}

/// Uploads the developed preview to the Self-Hosted API at
/// `PUT /api/preview?path=<urlencoded original asset path>` (endpoint from
/// #2017) — the cloud sibling of `CloudSidecarStore`'s XMP `PUT`. The server
/// overwrites its own copy of the same canonical `<filename>.avif`.
public struct CloudDisplayPreviewSink: DisplayPreviewSink {
    let server: URL
    /// The asset's original absolute path ON THE SERVER (e.g. `/lib/Photos/…
    /// /IMG_1234.CR2`), the same value `CloudSource` derives from the asset id.
    let assetPath: String
    let httpClient: AuthenticatedHTTPClient

    public init(server: URL, assetPath: String, httpClient: AuthenticatedHTTPClient) {
        self.server = server
        self.assetPath = assetPath
        self.httpClient = httpClient
    }

    public func write(_ bytes: Data) async {
        guard let req = Self.makeRequest(server: server, assetPath: assetPath, bytes: bytes)
        else { return }
        // Best-effort: a failed upload leaves the server to regenerate the
        // preview from the (already-synced) XMP via its display-preview stage.
        _ = try? await httpClient.data(for: req)
    }

    /// Build the `PUT /api/preview?path=<urlencoded assetPath>` request with an
    /// `image/avif` body. Static + pure so the wire contract (#2017 endpoint
    /// shape) is unit-testable without a live server. Returns nil only if URL
    /// composition fails (it never does for a valid server URL).
    static func makeRequest(server: URL, assetPath: String, bytes: Data) -> URLRequest? {
        guard var components = URLComponents(
            url: server.appending(path: "/api/preview"),
            resolvingAgainstBaseURL: false)
        else { return nil }
        components.queryItems = [URLQueryItem(name: "path", value: assetPath)]
        guard let url = components.url else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("image/avif", forHTTPHeaderField: "Content-Type")
        req.httpBody = bytes
        return req
    }
}
