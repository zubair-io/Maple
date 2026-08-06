// SMBSourceSidecarTests.swift — real, no-server-needed determinism coverage
// for the raw-bytes sidecar read/write primitives added to `SMBSource` for
// #2674 (`readSidecar(for: SMBAsset)`, `writeSidecarData(for: ImageRef)`,
// `readSidecarData(for: ImageRef)`).
//
// Same constraint the cross-adapter contract suite (#2431) documented for
// SMB: no live/loopback SMB server exists anywhere in this repo, and
// `SMB2Manager` (AMSMB2) is a concrete class, not a protocol, so there is no
// injectable fake transport the way `URLSession` gives the Cloud adapter.
// What IS real and testable without a server: every one of these methods
// guards `client != nil` and throws `SMBError.notConnected` deterministically
// otherwise — exercised below the same way the existing `writeSidecar`
// coverage would (see the SMB adapter's transaction-contract test file for
// the sibling `writeSidecar(for: SMBAsset)` case).

import XCTest
@testable import MapleCore

final class SMBSourceSidecarTests: XCTestCase {

    // MARK: - `readSidecar(for: SMBAsset)` (#2674)

    func testReadSidecarWithoutConnectingFailsDeterministically() async throws {
        let source = SMBSource()
        let asset = SMBSource.SMBAsset(path: "/Photos/IMG_0100.dng")

        do {
            _ = try await source.readSidecar(for: asset)
            XCTFail("read must fail without a connection")
        } catch let error as SMBError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        }
    }

    func testReadSidecarAfterDisconnectFailsDeterministically() async throws {
        let source = SMBSource()
        await source.disconnect()
        let asset = SMBSource.SMBAsset(path: "/Photos/IMG_0101.dng")

        do {
            _ = try await source.readSidecar(for: asset)
            XCTFail("read after disconnect must fail")
        } catch let error as SMBError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        }
    }

    // MARK: - `writeSidecarData(for: ImageRef)` / `readSidecarData(for: ImageRef)` (#2674)
    //
    // These are the `ImageRef`-keyed wrappers `SMBSidecarStore` actually
    // calls (it has a maple_id, not a share-relative `SMBAsset.path`, in
    // scope — see `AppShell+FolderActions.ensureSession`'s `.smb` branch).
    // Resolution goes through the same `path(for:)` lookup `writeXMP`/
    // `rawBytes(for:)` already use, which falls back to treating `ref.id`
    // itself as the path when there's no `pathByMapleId` entry (never
    // populated here — no `images()` call happened) — so these calls reach
    // the same `client == nil` guard as the `SMBAsset`-keyed pair.

    func testWriteSidecarDataWithoutConnectingFailsDeterministically() async throws {
        let source = SMBSource()
        let ref = ImageRef(id: "deadbeef", displayName: "IMG_0102.dng")

        do {
            try await source.writeSidecarData(Data("irrelevant".utf8), for: ref)
            XCTFail("write must fail without a connection")
        } catch let error as SMBError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        }
    }

    func testReadSidecarDataWithoutConnectingFailsDeterministically() async throws {
        let source = SMBSource()
        let ref = ImageRef(id: "deadbeef2", displayName: "IMG_0103.dng")

        do {
            _ = try await source.readSidecarData(for: ref)
            XCTFail("read must fail without a connection")
        } catch let error as SMBError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        }
    }
}
