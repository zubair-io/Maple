import Foundation

/// Compiled alongside the five unchanged production recipe units (#4207).
@main
struct RecipeInterchange {
  static func main() async throws {
    guard CommandLine.arguments.count == 2 else {
      throw NativeExportError.message("Usage: recipe-interchange ARTIFACT_DIRECTORY")
    }
    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let bytes = try Data(contentsOf: root.appendingPathComponent("rust.json"))
    guard let bundle = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let cases = bundle["semantic"] as? [[String: Any]], cases.count == 20,
      let malformed = bundle["malformed"] as? [[String: Any]], malformed.count == 8
    else { throw NativeExportError.message("Invalid frozen interchange inventory.") }
    let directory = root.appendingPathComponent("swift-saved-recipes", isDirectory: true)
    guard !FileManager.default.fileExists(atPath: directory.path) else {
      throw NativeExportError.message(
        "Use a fresh artifact directory; retained evidence is preserved.")
    }
    var identities: [String: UUID] = [:]
    for item in cases {
      guard let id = item["id"] as? String, identities[id] == nil else {
        throw NativeExportError.message("Duplicate or missing semantic case ID.")
      }
      let encoded = try JSONSerialization.data(withJSONObject: item["recipe"] as Any)
      let recipe = try JSONDecoder().decode(ExportRecipe.self, from: encoded)
      let saved = SavedNativeExportRecipe(recipe: recipe)
      // Actual durable production actor; no in-memory stand-in.
      try await NativeExportRecipeStore(directory: directory).save(saved)
      identities[id] = saved.id
    }
    // A new actor reconstructs all values from the persisted files.
    let reopened = try await NativeExportRecipeStore(directory: directory).list()
    guard reopened.count == 20 else {
      throw NativeExportError.message("Native saved store lost a recipe.")
    }
    let semantic: [[String: Any]] = try cases.map { item in
      let id = item["id"] as! String
      guard let saved = reopened.first(where: { $0.id == identities[id] }),
        let supported = item["supported"] as? Bool
      else { throw NativeExportError.message("Native store lost a case identity.") }
      let exported = try NativeExportRecipeBridge.json(saved.recipe)
      let recipe = try JSONSerialization.jsonObject(with: Data(exported.utf8))
      let accepted: Bool
      let error: Any
      do {
        try NativeExportRecipeBridge.validate(saved.recipe)
        accepted = true
        error = NSNull()
      } catch let failure {
        accepted = false
        error = failure.localizedDescription
      }
      guard accepted == supported else {
        throw NativeExportError.message("Native admission changed for \(id).")
      }
      return [
        "id": id, "supported": supported, "recipe": recipe,
        "accepted": accepted, "admissionError": error,
      ]
    }
    let invalid: [[String: Any]] = try malformed.map { item in
      let encoded = try JSONSerialization.data(withJSONObject: item["value"] as Any)
      let error: String
      do {
        _ = try JSONDecoder().decode(ExportRecipe.self, from: encoded)
        throw NativeExportError.message("Native decoder accepted malformed recipe.")
      } catch let failure as DecodingError {
        error = String(describing: failure)
      }
      return [
        "id": item["id"] as Any, "value": item["value"] as Any,
        "rejected": true, "error": error,
      ]
    }
    let result: [String: Any] = ["semantic": semantic, "malformed": invalid]
    try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
      .write(to: root.appendingPathComponent("swift.json"), options: .withoutOverwriting)
    print("Swift production saved-store PASS: 20 recipes, 8 malformed rejections")
  }
}
