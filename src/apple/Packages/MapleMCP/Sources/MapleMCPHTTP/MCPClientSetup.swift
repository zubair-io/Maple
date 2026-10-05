import Foundation

public enum MCPClientSetup {
  public static var claudeExtensionURL: URL? {
    Bundle.module.url(forResource: "Maple", withExtension: "mcpb")
  }

  public static func codex(url: URL, token: String) -> String {
    """
    [mcp_servers.maple]
    url = "\(url.absoluteString)"
    http_headers = { Authorization = "Bearer \(token)" }
    """
  }

  public static func cursor(url: URL, token: String) throws -> String {
    let config = [
      "mcpServers": [
        "maple": [
          "url": url.absoluteString, "type": "http",
          "headers": ["Authorization": "Bearer \(token)"],
        ]
      ]
    ]
    let data = try JSONSerialization.data(
      withJSONObject: config, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    return String(decoding: data, as: UTF8.self)
  }
}
