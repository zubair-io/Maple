// CloudByteDownloadBox.swift — single-download memoizer for a cloud asset's
// RAW bytes, with progress reporting (#822).
//
// The decode pipeline asks an `AssetRef.bytesProvider` for bytes more than
// once per open: once to read the native image size from metadata, once for
// the fast-phase decode, and once for the full-resolution refine. Pointing
// the provider straight at `CloudSource.rawBytes` would re-download the
// whole RAW each time — and, worse for #822, two concurrent fetches would
// both write into the same `DownloadProgress`, scrambling the byte count.
//
// This box wraps the fetch in one shared `Task<Data, Error>`: the first
// caller starts the download (through the progress-reporting transport),
// every later caller awaits the same task, and the bytes are downloaded
// exactly once. The `DownloadProgress` sink is driven only by that single
// stream. Progress callbacks arrive on the URLSession delegate queue; this
// box hops them to the main actor where `DownloadProgress` is isolated.

import Foundation

/// Memoizes a cloud asset's byte download behind one shared task and feeds
/// `DownloadProgress`. `Sendable` so the `bytesProvider` closure can call it
/// from a detached decode task.
public actor CloudByteDownloadBox {
    private let source: CloudSource
    private let imageRef: ImageRef
    private let expectedTotal: Int64?
    private let progress: DownloadProgress
    /// The single in-flight (or completed) download. `nil` until the first
    /// `bytes()` call kicks it off.
    private var task: Task<Data, Error>?

    public init(source: CloudSource,
                imageRef: ImageRef,
                expectedTotal: Int64?,
                progress: DownloadProgress) {
        self.source = source
        self.imageRef = imageRef
        self.expectedTotal = expectedTotal
        self.progress = progress
    }

    /// Return the asset's RAW bytes, downloading them on the first call and
    /// reusing the result on every later call. Progress is reported into the
    /// `DownloadProgress` sink for the duration of the (one) download.
    public func bytes() async throws -> Data {
        // Reuse a prior download only if it succeeded. A failed task must NOT
        // stay memoized: if it did, every later `bytes()` would rethrow the
        // same error forever and a transient failure (dropped connection,
        // expired auth) could never recover. Clear `self.task` on throw so the
        // next call starts a fresh attempt. The success path keeps the
        // download-once / single-shared-stream guarantee.
        if let task {
            do {
                return try await task.value
            } catch {
                self.task = nil
                throw error
            }
        }
        let imageRef = self.imageRef
        let expectedTotal = self.expectedTotal
        let progress = self.progress
        let source = self.source
        let task = Task<Data, Error> {
            await progress.begin(expectedBytes: expectedTotal)
            do {
                let data = try await source.rawBytesWithProgress(
                    for: imageRef,
                    expectedTotal: expectedTotal,
                    onProgress: { received, total in
                        // Hop to the main actor where DownloadProgress is
                        // isolated. URLSession delivers one delegate callback
                        // per network read (not per byte), so this is already
                        // throttled to a few hundred hops for a large RAW.
                        Task { @MainActor in
                            progress.report(received: received, total: total)
                        }
                    }
                )
                await progress.finish()
                return data
            } catch {
                await progress.finish()
                throw error
            }
        }
        self.task = task
        do {
            return try await task.value
        } catch {
            // First attempt failed — drop the memo so a subsequent `bytes()`
            // retries instead of replaying the cached failure.
            self.task = nil
            throw error
        }
    }
}
