// SMBSource+Thumbs.swift — on-share `.maple/thumbs/` cache read/write-back
// for SMBSource (#2690, follow-up to #2689's SMB browse-perf investigation).
//
// Split out of SMBSource.swift to keep that file under the file-size budget
// (see CONTRIBUTING.md "File-size budget") — this extension adds no new
// state, only the two `ImageSource` conformance methods that route through
// `SMBThumbCache`.

import Foundation
import AMSMB2

extension SMBSource {
    /// ONE transport read at `<assetDir>/.maple/thumbs/<hash>.avif` (#2690)
    /// — see `SMBThumbCache`'s file header for the full rationale. `nil` on
    /// a miss (not connected, or the entry doesn't exist yet) runs
    /// `ThumbnailLoader`'s existing render-from-bytes fallback unchanged;
    /// `writeThumb(_:for:)` below persists that fallback's render back to
    /// this same path.
    public func thumb(for ref: ImageRef) async throws -> Data? {
        guard let client else { return nil }
        return await SMBThumbCache(transport: client).read(forAssetPath: path(for: ref))
    }

    /// Write-back for `ThumbnailLoader`'s render-from-bytes fallback
    /// (#2690) — persists the freshly rendered AVIF to the same on-share
    /// path `thumb(for:)` reads, temp-then-rename, silently swallowing any
    /// failure (read-only share, dropped connection). See
    /// `SMBThumbCache.write`.
    public func writeThumb(_ data: Data, for ref: ImageRef) async {
        guard let client else { return }
        await SMBThumbCache(transport: client).write(data, forAssetPath: path(for: ref))
    }
}
