import XCTest

@testable import MapleCore

/// #5050 review: a server stack rename addresses the JPEG by the location the listing reported.
extension RawJpegStackServerTests {
  /// A JPEG the server holds at several locations used to fail every stack rename: the JPEG's
  /// rename went by ID alone, which the server refuses for such an asset (409, `rename.ts`), so
  /// the RAW was renamed and then put back.
  func testRenamingAStackRenamesTheJpegAtItsListedLocation() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.path.contains(self.jpegID), record.body["source_address"] == nil {
        return self.respond(
          request, status: 409,
          json: #"{"error":"Source address required for an asset with multiple locations"}"#)
      }
      let filename = record.body["new_filename"] as? String ?? ""
      return self.respond(
        request,
        json: """
          {"new_abs_path":"/srv/photos/Library/Trip/\(filename)","new_path":"Trip",
           "new_filename":"\(filename)","renamed_on_collision":false,"extension_changed":false}
          """)
    }

    let result = try await catalog.renameAsset(
      assetID: rawID, newFilename: "Beach.CR3", stack: stack)

    guard case .ok(let renamed) = result else { return XCTFail("rename failed: \(result)") }
    XCTAssertEqual(renamed.newFilename, "Beach.CR3")
    XCTAssertEqual(recorder.requests.count, 2, "no rollback of the RAW")
    let jpeg = try XCTUnwrap(recorder.requests.last)
    XCTAssertEqual(jpeg.path, "/api/assets/\(jpegID)/rename")
    XCTAssertEqual(jpeg.body["new_filename"] as? String, "Beach.JPG")
    XCTAssertEqual(jpeg.body["source_address"] as? String, "lib:Trip/IMG_1.JPG")
  }
}
