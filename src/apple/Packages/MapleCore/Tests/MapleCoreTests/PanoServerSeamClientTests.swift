import Foundation
import MapleCloudKit
import XCTest

@testable import MapleCore

final class PanoServerSeamClientTests: XCTestCase {
  private let server = URL(string: "https://seam-requests.example.test")!
  private let seams = SeamConstraintsRequest(
    canvas: .init(width: 1000, height: 400),
    regions: [.init(frame: 1, kind: .exclude, rect: .init(x: 20, y: 30, width: 40, height: 50))])

  private func request(_ seams: SeamConstraintsRequest?) -> PanoServerRequest {
    PanoServerRequest(
      assetPaths: ["/photos/a.dng", "/photos/b.dng"], libraryId: "library",
      options: .init(retention: "keep", localAlign: "mesh", strategy: "rotation"),
      alignmentFrom: "preview-alignment", seamConstraints: seams)
  }

  func testDecodedRequestRetainsVersionedIntentWhenReencoded() throws {
    let wire = """
      {"assetPaths":["/raw/a.dng","/raw/b.dng"],"libraryId":"library",
       "options":{"retention":"keep","localAlign":"mesh","strategy":"rotation"},
       "seamConstraints":{"version":1,"canvas":{"width":1000,"height":400},"regions":[
         {"frame":1,"kind":"exclude","x":20,"y":30,"width":40,"height":50}]}}
      """
    let decoded = try JSONDecoder().decode(PanoServerRequest.self, from: Data(wire.utf8))
    let encoded = try JSONEncoder().encode(decoded)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertNotNil(object["seamConstraints"])
    let original = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(wire.utf8)) as? [String: Any])
    XCTAssertEqual(
      object["seamConstraints"] as? NSDictionary, original["seamConstraints"] as? NSDictionary)
  }

  func testPreviewAndStitchHTTPBodiesUseExactSchemaAndOmitNilIntent() async throws {
    for preview in [true, false] {
      for constraints in [seams, nil] {
        let session = URLSession.stubbed(response: #"{"id":"created-job"}"#, status: 201)
        defer { session.invalidateAndCancel() }
        let client = PanoServerClient(
          server: server, httpClient: .unauthenticated(server: server, urlSession: session))
        let body = request(constraints)
        let id = try await (preview ? client.preview(body) : client.stitch(body))
        XCTAssertEqual(id, "created-job")
        let endpoint = preview ? "/api/pano/preview" : "/api/pano/stitch"
        let bytes = try XCTUnwrap(
          URLProtocolStub.capturedBodies[server.appending(path: endpoint).absoluteString])
        let decoded = try JSONDecoder().decode(PanoServerRequest.self, from: bytes)
        XCTAssertEqual(decoded, body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(object["alignmentFrom"] as? String, "preview-alignment")
        XCTAssertEqual(object["seamConstraints"] == nil, constraints == nil)
        XCTAssertNil((object["options"] as? [String: Any])?["seamConstraints"])
        if constraints != nil {
          let seam = try XCTUnwrap(object["seamConstraints"] as? [String: Any])
          XCTAssertEqual(Set(seam.keys), ["version", "canvas", "regions"])
          XCTAssertEqual(seam["version"] as? Int, 1)
          XCTAssertEqual(seam["canvas"] as? [String: Int], ["width": 1000, "height": 400])
          let region = try XCTUnwrap((seam["regions"] as? [[String: Any]])?.first)
          XCTAssertEqual(Set(region.keys), ["frame", "kind", "x", "y", "width", "height"])
          XCTAssertEqual(region["kind"] as? String, "exclude")
          XCTAssertEqual(region["frame"] as? Int, 1)
          XCTAssertEqual(region["x"] as? Int, 20)
          XCTAssertEqual(region["y"] as? Int, 30)
          XCTAssertEqual(region["width"] as? Int, 40)
          XCTAssertEqual(region["height"] as? Int, 50)
        }
      }
    }
  }

  func testBothCreateEndpointsPreserveInvalidSeamConstraintError() async throws {
    for preview in [true, false] {
      let session = URLSession.stubbed(
        response: #"{"error":"invalid_seam_constraints","message":"Conflicting regions"}"#,
        status: 422)
      defer { session.invalidateAndCancel() }
      let client = PanoServerClient(
        server: server, httpClient: .unauthenticated(server: server, urlSession: session))
      do {
        _ = try await (preview ? client.preview(request(seams)) : client.stitch(request(seams)))
        XCTFail("Expected API refusal")
      } catch {
        let refusal = try XCTUnwrap(error as? PanoServerError)
        XCTAssertEqual(refusal.statusCode, 422)
        XCTAssertEqual(refusal.code, "invalid_seam_constraints")
        XCTAssertEqual(refusal.message, "Conflicting regions")
        XCTAssertEqual(
          refusal.localizedDescription, "invalid_seam_constraints: Conflicting regions")
        XCTAssertFalse(ServerPanoStitcher.isTransient(refusal))
      }
    }
  }

  func testAlreadyNamedRefusalIsNotPrefixedTwice() {
    let refusal = PanoServerError(
      statusCode: 422, code: "invalid_seam_constraints",
      message: "invalid_seam_constraints: Outside canvas")
    XCTAssertEqual(refusal.localizedDescription, "invalid_seam_constraints: Outside canvas")
  }
}
