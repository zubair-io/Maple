import Foundation

/// One tool invocation sent from the MCP bridge to the running app.
public struct AgentRequest: Sendable, Equatable {
  public let id: Int
  public let tool: String
  public let arguments: [String: JSONValue]

  public init(id: Int, tool: String, arguments: [String: JSONValue]) {
    self.id = id
    self.tool = tool
    self.arguments = arguments
  }

  public var json: JSONValue {
    ["id": .int(id), "tool": .string(tool), "arguments": .object(arguments)]
  }

  public init?(json: JSONValue) {
    guard let number = json["id"]?.numberValue, let id = Int(exactly: number),
      let tool = json["tool"]?.stringValue
    else {
      return nil
    }
    self.init(id: id, tool: tool, arguments: json["arguments"]?.objectValue ?? [:])
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

  public var json: JSONValue {
    var fields: [String: JSONValue] = ["code": .string(code), "message": .string(message)]
    if let details { fields["details"] = details }
    return .object(fields)
  }

  public init?(json: JSONValue) {
    guard let code = json["code"]?.stringValue, let message = json["message"]?.stringValue else {
      return nil
    }
    self.init(code: code, message: message, details: json["details"])
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

  public var json: JSONValue {
    switch outcome {
    case .success(let payload):
      var fields: [String: JSONValue] = ["id": .int(id), "result": payload.result]
      if let image = payload.image {
        fields["image"] = [
          "data": .string(image.data.base64EncodedString()), "mimeType": .string(image.mimeType),
        ]
      }
      return .object(fields)
    case .failure(let error):
      return ["id": .int(id), "error": error.json]
    }
  }

  public init?(json: JSONValue) {
    guard let number = json["id"]?.numberValue, let id = Int(exactly: number) else { return nil }
    if let error = json["error"].flatMap(AgentError.init(json:)) {
      self.init(id: id, outcome: .failure(error))
      return
    }
    guard let result = json["result"] else { return nil }
    var image: AgentImage?
    if let encoded = json["image"]?["data"]?.stringValue,
      let mimeType = json["image"]?["mimeType"]?.stringValue,
      let data = Data(base64Encoded: encoded)
    {
      image = AgentImage(data: data, mimeType: mimeType)
    }
    self.init(id: id, outcome: .success(AgentPayload(result: result, image: image)))
  }
}

public struct AgentPayload: Sendable, Equatable {
  public let result: JSONValue
  public let image: AgentImage?

  public init(result: JSONValue, image: AgentImage? = nil) {
    self.result = result
    self.image = image
  }
}
