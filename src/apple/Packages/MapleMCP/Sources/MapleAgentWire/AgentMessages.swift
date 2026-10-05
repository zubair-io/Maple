import Foundation

/// One typed tool invocation forwarded from HTTP to the live editor.
public struct AgentRequest: Sendable, Equatable {
  public let id: Int
  public let tool: String
  public let arguments: [String: JSONValue]

  public init(id: Int, tool: String, arguments: [String: JSONValue]) {
    self.id = id
    self.tool = tool
    self.arguments = arguments
  }

}

/// A failure the agent can act on. `code` is a stable machine token
/// (`stale_revision`, `invalid_arguments`, `no_active_photo`, …); `message`
/// is written for the model to read and self-correct from.
public struct AgentError: Error, Sendable, Equatable {
  public let code: String
  public let message: String
  public let details: JSONValue?

  public init(code: String, message: String, details: JSONValue? = nil) {
    self.code = code
    self.message = message
    self.details = details
  }

}

/// An encoded image returned alongside a tool result.
public struct AgentImage: Sendable, Equatable {
  public let data: Data
  public let mimeType: String

  public init(data: Data, mimeType: String) {
    self.data = data
    self.mimeType = mimeType
  }
}

/// The app's answer to one `AgentRequest`: structured result data plus an
/// optional image, or an `AgentError`.
public struct AgentResponse: Sendable, Equatable {
  public let id: Int
  public let outcome: Result<AgentPayload, AgentError>

  public init(id: Int, outcome: Result<AgentPayload, AgentError>) {
    self.id = id
    self.outcome = outcome
  }

}

public struct AgentPayload: Sendable, Equatable {
  public let result: JSONValue
  public let images: [AgentImage]

  public var image: AgentImage? { images.first }

  public init(result: JSONValue, image: AgentImage? = nil) {
    self.result = result
    self.images = image.map { [$0] } ?? []
  }

  public init(result: JSONValue, images: [AgentImage]) {
    self.result = result
    self.images = images
  }
}
