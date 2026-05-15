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
