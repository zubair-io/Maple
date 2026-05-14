// Tests/MapleBackupTests/UploadClientTests.swift
import XCTest
@testable import MapleBackup

final class UploadClientTests: XCTestCase {

    override func setUp() {
        StubURLProtocol.stub = nil
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
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
