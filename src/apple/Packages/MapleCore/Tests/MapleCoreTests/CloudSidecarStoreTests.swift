// CloudSidecarStoreTests.swift
import XCTest
@testable import MapleCore

final class CloudSidecarStoreTests: XCTestCase {

  func test_load_404_returnsDefaults() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "", contentType: "text/plain", status: 404)
    let store = CloudSidecarStore(
      server: server, assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let (model, culling) = try await store.load()
    XCTAssertEqual(model.exposure, AdjustmentModel.default.exposure)
    XCTAssertEqual(culling.stars, 0)
  }

  func test_flush_PUTsSerializedXml() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(url: req.url!, statusCode: 204,
                                 httpVersion: "HTTP/1.1", headerFields: nil)!
      return (Data(), resp)
    }
    let store = CloudSidecarStore(
      server: server, assetID: "a1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    var model = AdjustmentModel.default
    model.exposure = 1.5
    var culling = CullingState()
    culling.stars = 4
    await store.update(model: model, culling: culling)
    await store.flush()

    let body = URLProtocolStub.capturedBodies["https://x/api/assets/a1/xmp"]
    XCTAssertNotNil(body)
    let xml = String(data: body ?? Data(), encoding: .utf8) ?? ""
    XCTAssertTrue(xml.contains("xmpmeta"))
  }
}
