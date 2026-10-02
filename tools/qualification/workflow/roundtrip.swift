// #4035: exercise the actual generated Apple Codable records in the cycle.
import Foundation

@main
struct WorkflowRoundTrip {
  static func main() throws {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let records = try JSONDecoder().decode([SidecarWorkflow].self, from: input)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    FileHandle.standardOutput.write(try encoder.encode(records))
  }
}
