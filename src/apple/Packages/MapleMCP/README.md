# MapleMCP

Maple on macOS serves MCP directly from the running app at **`http://127.0.0.1:49157/mcp`**. Enable **Settings → General → AI Agents** to start it. Settings shows the actual URL, access token copy action, client configurations, port control, and startup errors. Maple must stay open. No command-line build or separately installed server is needed.

## Connect a desktop client

- **Codex:** choose **Copy Codex configuration** and add it to `~/.codex/config.toml`. It includes the URL and bearer header.
- **Cursor:** choose **Copy Cursor configuration** and add its `maple` entry to `~/.cursor/mcp.json`, preserving other servers.
- **Claude Desktop:** choose **Save Claude Desktop extension…**. In Claude Desktop, open Settings → Extensions → Advanced settings → Install Extension and select `Maple.mcpb`. Configure the URL from Maple Settings and the copied access token. Claude supplies Node; the extension forwards stdio messages to the same app-owned URL. Claude's cloud-based custom connector cannot reach this localhost server.

Port 49157 is stable across launches. If another service occupies it, Settings reports the failure; select another port and update clients. The token is generated from secure random bytes and persists in the macOS Keychain. Treat copied configurations as credentials.

## Transport and editing contract

`MapleMCPHTTP` uses SwiftNIO for a stateless Streamable HTTP endpoint bound only to `127.0.0.1`. Every request requires a bearer token. Host and optional Origin must match the loopback endpoint, preventing browser-origin access and DNS rebinding. There is no CORS allowance, LAN listener, or remote relay. POST accepts JSON and advertises JSON plus SSE in Accept; replies use JSON, notifications receive 202, and GET receives 405 because this server has no server-initiated stream. It supports modern `2026-07-28` metadata headers and legacy `2025-11-25` / `2025-06-18` initialization. Requests are capped at 1 MiB, connections at 32, incomplete uploads at 10 seconds, and tool responses at 65 seconds.

HTTP calls await MapleCore's existing `AgentEditService` in process. Its tool catalog, live editor state, expected revisions, undo transactions, render inspection, and real XMP writes are shared with the existing socket bridge. Disabling agent access invalidates queued calls and closes the HTTP listener and clients. The HTTP service works independently of the App Group socket's availability.

The app has `com.apple.security.network.server` for sandboxed incoming connections. This is a macOS feature; iOS and tvOS do not link its HTTP product. Successful development builds do not qualify Mac App Store distribution: a signed distribution archive and App Review remain release gates.

## Existing developer stdio bridge

`MapleAgentWire` retains the same-user, mode-0600 Unix socket at `~/Library/Group Containers/group.app.justmaple.aperture/maple-agent.sock`. `MapleMCPServer` shares routing and serialization between HTTP and the `maple-mcp` developer executable. Existing qualification tooling can still run `swift build -c release --product maple-mcp` and connect over stdio. End users use the app's URL.

## Build and verify

```sh
swift test --package-path src/apple/Packages/MapleMCP
python3 src/apple/Packages/MapleMCP/package-claude-extension.py --check
```

Tests exercise real Unix sockets and HTTP listeners, authentication and origin checks, protocol negotiation, modern metadata, port conflicts, shutdown, and the actual Claude Node adapter against the same server. MapleCore's `AgentHTTPIntegrationTests` checks edits, stale revisions, undo, XMP persistence, and original-file preservation over HTTP.

The Claude extension source is `ClaudeDesktop/`; the app bundles `Sources/MapleMCPHTTP/Resources/Maple.mcpb`. After editing its manifest or adapter, run `python3 src/apple/Packages/MapleMCP/package-claude-extension.py`. CI verifies the bundled archive matches source. The extension contains no external dependencies or independent editing implementation.
