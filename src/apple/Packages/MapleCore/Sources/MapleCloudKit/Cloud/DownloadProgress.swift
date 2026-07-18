// DownloadProgress.swift — observable byte-download progress for a single
// remote asset open (#822).
//
// A cloud image's full RAW bytes are fetched over HTTP before the decode
// pipeline can run. On a 50–100 MP RAW over a slow link that's a multi-
// second wait with no feedback — the editor's canvas just sits on the
// placeholder. This object lets the byte fetch report `received / total`
// so the editor can render a determinate progress bar.
//
// Ownership: one instance is created per cloud open in
// `prepareCloudSession`, captured by the asset's progress-reporting
// bytes provider, and handed to the `EditSession`. Local / PhotoKit opens
// never construct one (their providers report no progress), so the editor
// gates the bar on `session.downloadProgress != nil && isDownloading` —
// which naturally excludes them.
//
// `@MainActor` because SwiftUI reads it during `body`; the byte fetch runs
// on a detached task and funnels updates back through `report(...)` via a
// MainActor hop. The fetch throttles those hops (see `CloudSource
// .rawBytesWithProgress`) so a large download doesn't flood the main
// actor with per-chunk writes.

import Foundation

/// Observable download state for one in-flight remote byte fetch.
@MainActor
@Observable
public final class DownloadProgress {
    /// Bytes received so far.
    public private(set) var receivedBytes: Int64 = 0
    /// Expected total in bytes. `nil` until known (the server's
    /// `Content-Length`, or the asset's catalog `size` as a fallback). When
    /// it stays `nil` the bar should render indeterminate.
    public private(set) var expectedBytes: Int64?
    /// True from the moment the fetch starts until it finishes (success or
    /// failure). The editor shows the bar only while this is `true`.
    public private(set) var isDownloading: Bool = false

    /// When `begin(...)` was called — anchor for the running-average speed
    /// computation. `nil` before the first `begin` so a freshly constructed
    /// progress object reports no speed.
    private var startedAt: Date?

    public init(expectedBytes: Int64? = nil) {
        self.expectedBytes = expectedBytes
    }

    /// Completion fraction in `0...1`, or `nil` when the total is unknown
    /// (indeterminate) or non-positive. Clamped so a server that reports a
    /// smaller `Content-Length` than the bytes actually streamed (rare, but
    /// possible with chunked re-encodes) never pushes the bar past full.
    public var fraction: Double? {
        guard let expectedBytes, expectedBytes > 0 else { return nil }
        let f = Double(receivedBytes) / Double(expectedBytes)
        return min(max(f, 0), 1)
    }

    /// Running-average download speed in bytes per second, computed against
    /// the wall-clock anchor stamped at `begin`. Returns `nil` before the
    /// first reported chunk lands and during the very first 100 ms (the
    /// rate isn't meaningful inside that window — a single chunk skews
    /// arbitrarily). Recomputed on every Observable read (the body re-fires
    /// whenever `receivedBytes` updates, so it ticks smoothly as the
    /// download progresses without needing a timer).
    public var bytesPerSecond: Double? { bytesPerSecond(asOf: Date()) }

    /// Deterministic core of `bytesPerSecond` — accepts the "now" instant so
    /// unit tests can pin the elapsed window without sleeping. Production
    /// callers should read the computed property; this is intentionally
    /// non-private only because the test target needs it.
    public func bytesPerSecond(asOf now: Date) -> Double? {
        guard let startedAt, receivedBytes > 0 else { return nil }
        let elapsed = now.timeIntervalSince(startedAt)
        guard elapsed >= 0.1 else { return nil }
        return Double(receivedBytes) / elapsed
    }

    /// Mark the fetch as started. Resets the byte counter and adopts the
    /// best-known total. Pass the catalog size up front so the bar is
    /// determinate from the first frame even before the HTTP response
    /// headers land; `report(received:total:)` refines `expectedBytes`
    /// to the server's `Content-Length` once it's known. The optional `at`
    /// parameter is for tests that need a stable speed anchor; production
    /// callers omit it and the wall clock is stamped.
    public func begin(expectedBytes: Int64?, at startedAt: Date = Date()) {
        self.receivedBytes = 0
        if let expectedBytes, expectedBytes > 0 {
            self.expectedBytes = expectedBytes
        }
        self.isDownloading = true
        self.startedAt = startedAt
    }

    /// Update the received-byte count (and, when newly known, the total).
    /// Called from the fetch's progress callback on the main actor.
    public func report(received: Int64, total: Int64?) {
        self.receivedBytes = received
        if let total, total > 0 {
            self.expectedBytes = total
        }
    }

    /// Mark the fetch as finished (bytes landed or the request failed).
    /// Leaves `receivedBytes` / `expectedBytes` intact so a brief "100%"
    /// frame is possible before the canvas swaps in; the editor stops
    /// showing the bar because `isDownloading` is now `false`.
    public func finish() {
        self.isDownloading = false
    }
}
