// SMBSidecarStoreTests.swift — regression coverage for #2674's
// `SMBSidecarStore`, the `SidecarStoreProtocol` conformer that
// `AppShell+FolderActions.ensureSession` now wires for `.smb`-provenance
// assets instead of falling through to `sidecarStore = nil`.
//
// No live SMB server exists in this repo (see `SMBSourceSidecarTests.swift`
// and the SMB adapter's transaction-contract test file for the same
// constraint), so a genuine write→reconnect→read round trip isn't
// buildable here. What IS real and provable without a server: the store
// actually calls through to the underlying `SMBSource` — proven by driving
// an UNCONNECTED source (itself a real, deterministic SMB state, not a
// mock) through the full `update -> debounce -> write -> error` path and
// observing the real `SMBError.notConnected` come out the other end. A
// stub/no-op store (the pre-fix `sidecarStore = nil` shape) could never
// produce this error — its complete absence is exactly the silent-data-loss
// bug #2674 fixes.

import XCTest
@testable import MapleCore

final class SMBSidecarStoreTests: XCTestCase {

    private func makeStore() -> SMBSidecarStore {
        let source = SMBSource()
        let ref = ImageRef(id: "cafef00d", displayName: "IMG_2674.dng")
        return SMBSidecarStore(source: source, ref: ref)
    }

    // MARK: - Read path

    func testLoadOnUnconnectedSourcePropagatesNotConnected() async throws {
        let store = makeStore()
        do {
            _ = try await store.load()
            XCTFail("load() must surface the underlying SMB failure, not swallow it")
        } catch let error as SMBError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        }
    }

    func testLoadIfPresentOnUnconnectedSourcePropagatesNotConnected() async throws {
        let store = makeStore()
        do {
            _ = try await store.loadIfPresent()
            XCTFail("loadIfPresent() must surface the underlying SMB failure, not swallow it")
        } catch let error as SMBError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        }
    }

    // MARK: - Write path (proves `update` really reaches `SMBSource`)

    /// A model edit through `update()` + an immediate `flush()` must attempt
    /// a REAL write against the underlying `SMBSource` — surfaced through
    /// `errors()` as `SMBError.notConnected` here because the source was
    /// never connected. Before #2674, no `SidecarStoreProtocol` was ever
    /// constructed for SMB assets at all, so this call path was completely
    /// unreachable; this test is the closest available proof, absent a live
    /// server, that the fix's write path is real rather than a new stub.
    func testUpdateThenFlushOnUnconnectedSourceSurfacesNotConnectedViaErrorsStream() async throws {
        let store = makeStore()

        // Register the subscription BEFORE scheduling the write —
        // `AsyncStream`'s continuation is created synchronously inside the
        // actor-isolated `errors()` call, so by the time this `await`
        // returns the stream is guaranteed to observe every subsequent
        // `yield`. `AsyncStream`'s default `.unbounded` buffering policy
        // then means `iterator.next()` below sees the error even though it
        // was yielded (by `flush()`'s synchronous `writePending()` call)
        // before this test starts iterating.
        let stream = await store.errors()

        await store.update(model: .default, culling: CullingState())
        await store.flush()

        var iterator = stream.makeAsyncIterator()
        let received = await iterator.next()

        let unwrapped = try XCTUnwrap(
            received, "update()+flush() never attempted a real SMB write")
        guard case .notConnected = unwrapped as? SMBError else {
            return XCTFail("expected SMBError.notConnected, got \(unwrapped)")
        }
    }
}
