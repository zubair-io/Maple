# MapleMCP

Lets a local AI agent (Claude Desktop or any MCP client) edit the photo open in Maple's macOS editor. The photographer watches the sliders move and can undo each step.

```
MCP client ──stdio──▶ maple-mcp ──Unix socket──▶ Maple.app (EditSession)
```

- **`MapleAgentWire`** is newline-delimited JSON on `~/Library/Group Containers/group.app.justmaple.aperture/maple-agent.sock`. The socket is `0600` and only accepts peers running as the same user. MapleCore links this target and serves it from `AgentBridge/`.
- **`MapleMCPServer`** handles MCP JSON-RPC and holds the tool catalog. It speaks both protocol eras: modern clients use `server/discover` with `2026-07-28`, and legacy clients use `initialize` with `2025-11-25` or `2025-06-18`.
- **`maple-mcp`** is the stdio executable that clients launch. It holds no photo state. Maple owns rendering, undo, and XMP persistence.

## Setup

1. In Maple, turn on Settings → General → **AI Agents**.
2. Build the bridge:

   ```sh
   cd src/apple/Packages/MapleMCP
   swift build -c release --product maple-mcp
   ```

3. Add the bridge to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude Desktop:

   ```json
   {
     "mcpServers": {
       "maple": { "command": "/ABSOLUTE/PATH/src/apple/Packages/MapleMCP/.build/release/maple-mcp" }
     }
   }
   ```

If Maple isn't running or AI Agents is off, every tool call returns an `isError` result that tells you so. The bridge never edits files on its own.

## Tools

| Tool | What it does |
| --- | --- |
| `maple_get_active_photo` | Returns the photo id, a `revision` token, and each slider's `{value, min, max}`. |
| `maple_set_adjustments` | Sets absolute slider values as one undo step. Needs `expected_revision`. Out-of-range values are rejected, not clamped. |
| `maple_render_and_inspect` | Returns a JPEG of the on-screen render plus display-referred metrics computed from the same pixels. Accepts an optional normalized `region`. |
| `maple_undo` / `maple_reset` | Undo one step, or reset the photo to its original state. Both need `expected_revision`. |

The `revision` is derived from the photo identity and its full adjustment state. Switching photos, a manual edit, or an undo all invalidate it. When that happens the agent gets `stale_revision` along with the current state, and nothing is applied.

## Tests

```sh
swift test   # real Unix sockets, and the built maple-mcp driven over stdio
```
