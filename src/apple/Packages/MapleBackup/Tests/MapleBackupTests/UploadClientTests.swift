// Tests/MapleBackupTests/UploadClientTests.swift
import XCTest
@testable import MapleBackup

final class UploadClientTests: XCTestCase {

    override func setUp() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }

    private func makeClient(chunkSize: Int = 4 * 1024 * 1024) async -> UploadClient {
        let client = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "dev",
                                  session: stubSession())
        await client.setChunkSize(chunkSize)
        return client
    }

    func testHappyPathSingleChunk() async throws {
        StubURLProtocol.stub = .ok(json: #"{"maple_id":"abc","target_rel_path":"2024/Tokyo/03-15/IMG.heic"}"#)
        let client = await makeClient()
        let result = try await client.upload(
            phassetLocalId: "P1", filename: "IMG.heic",
            captureDate: Date(timeIntervalSince1970: 1_700_000_000),
            lat: nil, lon: nil,
            bytes: Data(count: 256), mapleId: "abc")
        XCTAssertEqual(result.targetRelPath, "2024/Tokyo/03-15/IMG.heic")
        XCTAssertEqual(result.mapleId, "abc")
    }

    func testHttpErrorThrows() async throws {
        StubURLProtocol.stub = .status(500)
        let client = await makeClient()
        do {
            _ = try await client.upload(
                phassetLocalId: "P1", filename: "IMG.heic",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                lat: nil, lon: nil,
                bytes: Data(count: 256), mapleId: "abc")
            XCTFail("expected throw")
        } catch UploadClient.UploadError.httpError(let code) {
            XCTAssertEqual(code, 500)
        } catch {
            XCTFail("expected httpError(500), got \(error)")
        }
    }

    func testMissingHeadersThrows() async throws {
        StubURLProtocol.stub = .status(400, json: #"{"error":"missing required headers"}"#)
        let client = await makeClient()
        do {
            _ = try await client.upload(
                phassetLocalId: "P1", filename: "IMG.heic",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                lat: nil, lon: nil,
                bytes: Data(count: 256), mapleId: "abc")
            XCTFail("expected throw")
        } catch UploadClient.UploadError.httpError(let code) {
            XCTAssertEqual(code, 400)
        } catch {
            XCTFail("expected httpError(400)")
        }
    }

    /// When `phassetCloudId` is passed, the `X-Maple-PHAsset-Cloud-Id`
    /// header must be set on every chunk's request — the server reads it
    /// once per chunk and only persists the value alongside the final
    /// chunk's link entry, but a future server change might inspect it
    /// earlier, so it has to be present everywhere consistently.
    /// Forces a multi-chunk upload by shrinking chunkSize to 100 bytes
    /// against a 256-byte payload (3 chunks total: 100 + 100 + 56), and
    /// asserts the header on EVERY recorded request.
    func testPhassetCloudIdSentAsHeaderOnEveryChunk() async throws {
        // Final chunk returns the success JSON; the two preceding chunks
        // get 202 + next_offset.
        StubURLProtocol.stub = .sequence([
            .status(202, json: #"{"next_offset":100}"#),
            .status(202, json: #"{"next_offset":200}"#),
            .ok(json: #"{"maple_id":"abc","target_rel_path":"x"}"#),
        ])
        let client = await makeClient(chunkSize: 100)
        _ = try await client.upload(
            phassetLocalId: "P1", filename: "IMG.heic",
            captureDate: Date(timeIntervalSince1970: 1_700_000_000),
            lat: nil, lon: nil,
            bytes: Data(count: 256), mapleId: "abc",
            phassetCloudId: "icloud-XYZ")
        let reqs = StubURLProtocol.recordedRequests
        XCTAssertEqual(reqs.count, 3, "expected three chunks, got \(reqs.count)")
        for (idx, req) in reqs.enumerated() {
            XCTAssertEqual(req.value(forHTTPHeaderField: "X-Maple-PHAsset-Cloud-Id"),
                           "icloud-XYZ",
                           "X-Maple-PHAsset-Cloud-Id missing/wrong on chunk \(idx)")
        }
    }

    /// Conversely, omitting `phassetCloudId` must NOT set the header on
    /// any chunk (server treats absence as "device has no cloud id for
    /// this asset"). Same multi-chunk setup as the positive test.
    func testPhassetCloudIdHeaderAbsentOnEveryChunkWhenNil() async throws {
        StubURLProtocol.stub = .sequence([
            .status(202, json: #"{"next_offset":100}"#),
            .status(202, json: #"{"next_offset":200}"#),
            .ok(json: #"{"maple_id":"abc","target_rel_path":"x"}"#),
        ])
        let client = await makeClient(chunkSize: 100)
        _ = try await client.upload(
            phassetLocalId: "P1", filename: "IMG.heic",
            captureDate: Date(timeIntervalSince1970: 1_700_000_000),
            lat: nil, lon: nil,
            bytes: Data(count: 256), mapleId: "abc")
        let reqs = StubURLProtocol.recordedRequests
        XCTAssertEqual(reqs.count, 3)
        for (idx, req) in reqs.enumerated() {
            XCTAssertNil(req.value(forHTTPHeaderField: "X-Maple-PHAsset-Cloud-Id"),
                         "X-Maple-PHAsset-Cloud-Id unexpectedly set on chunk \(idx)")
        }
    }

    /// 423 on the first chunk means another device on the same iCloud
    /// library is actively uploading this asset. Client surfaces the
    /// back-off hint so the engine can requeue without burning a retry slot.
    func test423BusyElsewhereSurfacesBackoffHint() async throws {
        StubURLProtocol.stub = .status(
            423,
            json: #"{"error":"another device is actively uploading this asset","retry_after_seconds":120}"#)
        let client = await makeClient()
        do {
            _ = try await client.upload(
                phassetLocalId: "P1", filename: "IMG.heic",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                lat: nil, lon: nil,
                bytes: Data(count: 256), mapleId: "abc",
                phassetCloudId: "icloud-XYZ")
            XCTFail("expected throw")
        } catch UploadClient.UploadError.busyElsewhere(let retry) {
            XCTAssertEqual(retry, 120)
        } catch {
            XCTFail("expected busyElsewhere, got \(error)")
        }
    }

    /// Missing fields in the 423 body fall back to a safe default so the
    /// engine can still requeue if the server speaks a slightly different
    /// dialect.
    func test423WithEmptyBodyFallsBackToDefaults() async throws {
        StubURLProtocol.stub = .status(423, json: "{}")
        let client = await makeClient()
        do {
            _ = try await client.upload(
                phassetLocalId: "P1", filename: "IMG.heic",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                lat: nil, lon: nil,
                bytes: Data(count: 256), mapleId: "abc",
                phassetCloudId: "icloud-XYZ")
            XCTFail("expected throw")
        } catch UploadClient.UploadError.busyElsewhere(let retry) {
            XCTAssertGreaterThan(retry, 0)
        } catch {
            XCTFail("expected busyElsewhere, got \(error)")
        }
    }

    /// The rendered endpoint sends X-Maple-PHAsset-Cloud-Id on every chunk
    /// when the caller supplies a cloud id — server uses this to detect
    /// cross-device rendered collisions and return 423.
    func testUploadRenderedSendsPhassetCloudIdHeader() async throws {
        StubURLProtocol.stub = .sequence([
            .status(202, json: #"{"next_offset":100}"#),
            .ok(json: #"{"target_rel_path":"x"}"#),
        ])
        let client = await makeClient(chunkSize: 100)
        try await client.uploadRendered(
            phassetLocalId: "P1",
            targetRelPath: "2024/Tokyo/IMG.heic",
            filenameExt: "jpeg",
            bytes: Data(count: 200),
            phassetCloudId: "icloud-RENDERED")
        let reqs = StubURLProtocol.recordedRequests
        XCTAssertEqual(reqs.count, 2)
        for req in reqs {
            XCTAssertEqual(req.value(forHTTPHeaderField: "X-Maple-PHAsset-Cloud-Id"),
                           "icloud-RENDERED")
        }
    }

    /// Regression for #223: when the server short-circuits a retry of an
    /// already-completed upload, it returns 200 on the FIRST chunk (not the
    /// final one) with `{ maple_id, target_rel_path }`. Before the fix, the
    /// client threw `badResponse` because it required 200 only on the final
    /// chunk; the engine then transitioned the task back to .pending and
    /// burned retry slots until .failedRetry.
    func testUploadAccepts200OnNonFinalChunkAsAlreadyComplete() async throws {
        StubURLProtocol.stub = .ok(
            json: #"{"maple_id":"already-done","target_rel_path":"2024/Tokyo/IMG.heic"}"#)
        let client = await makeClient(chunkSize: 100)
        // 256 total bytes, chunkSize 100 → would normally be three chunks.
        // The server replies 200 on the first chunk (asset is already
        // complete from a prior successful ingest) so the loop terminates
        // immediately.
        let result = try await client.upload(
            phassetLocalId: "P1", filename: "IMG.heic",
            captureDate: Date(timeIntervalSince1970: 1_700_000_000),
            lat: nil, lon: nil,
            bytes: Data(count: 256), mapleId: "client-computed-id")
        XCTAssertEqual(result.mapleId, "already-done",
                       "client must trust server's stored maple_id from the completed session")
        XCTAssertEqual(result.targetRelPath, "2024/Tokyo/IMG.heic")
        // Only one request should have gone out — the server's 200 short-
        // circuit means the remaining chunks are not sent.
        XCTAssertEqual(StubURLProtocol.recordedRequests.count, 1,
                       "expected exactly one chunk before short-circuit, got \(StubURLProtocol.recordedRequests.count)")
    }

    /// Same short-circuit semantics for `uploadRendered`: a 200 on any chunk
    /// means the rendered companion is already complete server-side.
    func testUploadRenderedAccepts200OnNonFinalChunkAsAlreadyComplete() async throws {
        StubURLProtocol.stub = .ok(json: #"{"target_rel_path":"x"}"#)
        let client = await makeClient(chunkSize: 100)
        // No throw expected — the client returns without sending the rest.
        try await client.uploadRendered(
            phassetLocalId: "P1",
            targetRelPath: "2024/Tokyo/IMG.heic",
            filenameExt: "jpeg",
            bytes: Data(count: 250))
        XCTAssertEqual(StubURLProtocol.recordedRequests.count, 1,
                       "expected exactly one chunk before short-circuit")
    }

    func testNetworkErrorPropagates() async throws {
        StubURLProtocol.stub = .networkError(.notConnectedToInternet)
        let client = await makeClient()
        do {
            _ = try await client.upload(
                phassetLocalId: "P1", filename: "IMG.heic",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                lat: nil, lon: nil,
                bytes: Data(count: 256), mapleId: "abc")
            XCTFail("expected throw")
        } catch {
            // Underlying URLError propagates; the engine handles retry.
        }
    }
}
