import Foundation

/// What a library-relative path holds on the server: nothing, a regular file, or something else
/// (a folder).
public enum RemotePathOccupant: Sendable, Equatable {
  case free, file, notAFile
}

extension RemoteCatalog {
  /// What the library `folderID` holds at `relativePath`. `file-meta` answers 404 for a folder as
  /// for a missing file, with the error "not a regular file" (`routes/folders.ts`), so `statFile`
  /// reads a folder as a free name; a check that a name is free before a move must not.
  public func occupant(folderID: String, relativePath: String) async throws -> RemotePathOccupant {
    var comps = URLComponents(
      url: server.appending(path: "/api/folders/\(folderID)/file-meta"),
      resolvingAgainstBaseURL: false)!
    comps.queryItems = [.init(name: "path", value: relativePath)]
    let req = URLRequest(url: comps.url!)
    let (data, resp) = try await http.data(for: req)
    if (resp as? HTTPURLResponse)?.statusCode == 404 {
      struct ErrorBody: Decodable { let error: String? }
      let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
      return body?.error == "not a regular file" ? .notAFile : .free
    }
    try Self.check2xx(resp, data: data, url: req.url)
    return .file
  }
}
