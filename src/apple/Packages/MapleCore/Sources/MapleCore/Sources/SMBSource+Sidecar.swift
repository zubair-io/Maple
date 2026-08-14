// SMBSource+Sidecar.swift — raw XMP sidecar I/O over SMB (#2674).
//
// Split out of `SMBSource.swift` to keep that file inside the repo's
// size budget, mirroring the existing `SMBSource+Thumbs.swift` split.
// These are the read/write primitives `SMBSidecarStore` drives; the
// model-level `writeXMP(_:for:)` stays next to the other `ImageSource`
// conformance members it sits among.

import Foundation

extension SMBSource {

    /// Read raw XMP sidecar bytes over SMB (#2674), or `nil` when no
    /// sidecar has been written for `asset` yet. Mirrors `writeSidecar`'s
    /// path derivation exactly (same `.xmp`-beside-the-original convention
    /// every other adapter uses).
    ///
    /// A missing sidecar surfaces as `smb2_open` failing with
    /// `STATUS_OBJECT_NAME_NOT_FOUND`, which AMSMB2 translates to a
    /// `POSIXError` with `.ENOENT` (`nterror_to_errno` in the vendored
    /// AMSMB2 checkout) — caught here and folded to `nil`, matching
    /// `XMPSidecarStore.loadIfPresent`'s "no file yet" contract. Any other
    /// error (a genuine connection drop, permission fault, etc.) propagates
    /// so a caller can't mistake a transient failure for "fresh asset."
    public func readSidecar(for asset: SMBAsset) async throws -> Data? {
        guard let client else { throw SMBError.notConnected }
        let sidecarPath = (asset.path as NSString)
            .deletingPathExtension
            .appending(".xmp")
        do {
            return try await client.contents(atPath: sidecarPath, range: Range<UInt64>?.none)
        } catch let error as POSIXError where error.code == .ENOENT {
            return nil
        }
    }


    /// Raw-bytes sidecar write keyed by `ImageRef` (#2674) — used by
    /// `SMBSidecarStore`, which (like `XMPSidecarStore`) owns the XMP-domain
    /// serialization (model/culling/passthrough) itself rather than going
    /// through `writeXMP`'s model-only `Sidecar` shape, so a slider edit
    /// doesn't clobber foreign passthrough content on write. Resolves
    /// `ref.id` (the maple_id `ensureSession` actually has in hand — no
    /// `SMBAsset` in scope there) to the real share path the same way
    /// `writeXMP`/`rawBytes(for:)` do, then delegates to the
    /// `SMBAsset`-keyed `writeSidecar` so there is exactly one retry
    /// implementation.
    public func writeSidecarData(_ data: Data, for ref: ImageRef) async throws {
        try await writeSidecar(data, for: SMBAsset(path: path(for: ref)))
    }

    /// Raw-bytes sidecar read keyed by `ImageRef` (#2674) — the read-side
    /// counterpart to `writeSidecarData`, resolving through the same
    /// `SMBAsset`-keyed `readSidecar`.
    public func readSidecarData(for ref: ImageRef) async throws -> Data? {
        try await readSidecar(for: SMBAsset(path: path(for: ref)))
    }
}
