import Foundation

public enum MCPClientSetup {
  public static var claudeExtensionURL: URL? {
    Bundle.module.url(forResource: "Maple", withExtension: "mcpb")
  }

  public static func prompt(url: URL, token: String) throws -> String {
    guard let extensionURL = claudeExtensionURL else {
      throw CocoaError(.fileNoSuchFile)
    }
    return """
      Configure this AI tool to connect to Maple's local MCP server on this Mac.
      Preserve other servers and settings; add or update only the server named maple.

      Transport: Streamable HTTP
      Server URL: \(url.absoluteString)
      Authorization header: Bearer \(token)

      For Codex, add this to ~/.codex/config.toml:
      \(codex(url: url, token: token))

      For Cursor, merge this maple entry into ~/.cursor/mcp.json:
      \(try cursor(url: url, token: token))

      For Claude Desktop, use Maple's bundled local extension, since Claude's
      cloud connectors cannot reach localhost. Copy this file to ~/Downloads/Maple.mcpb:
      \(extensionURL.path)
      Install it through Claude Desktop Settings → Extensions → Advanced settings
      → Install Extension, then enter the server URL and access token above
      (without the "Bearer " prefix in the extension's token field).
      If you cannot operate that settings screen, guide me through these steps.

      Reload or restart the MCP connection if required, then list Maple's tools
      to verify the connection. Keep Maple open with AI Agents enabled.
      Treat the access token as private; do not commit it to a repository.
      """
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
