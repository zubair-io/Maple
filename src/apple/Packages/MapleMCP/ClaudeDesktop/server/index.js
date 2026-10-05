// Claude Desktop supplies Node. This adapter forwards JSON-RPC to Maple's
// app-owned HTTP server; it holds no photo state and never edits files.
const readline = require('node:readline');

let endpoint;
try {
  endpoint = new URL(process.env.MAPLE_MCP_URL);
} catch {
  endpoint = null;
}
if (
  !endpoint ||
  endpoint.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
  endpoint.pathname !== '/mcp' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  !process.env.MAPLE_MCP_TOKEN
) {
  process.stderr.write(
    'Configure the Maple localhost URL and access token in extension settings.\n',
  );
  process.exit(64);
}

let version = '2025-11-25';
async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }) + '\n',
    );
    return;
  }
  try {
    const headers = {
      Authorization: `Bearer ${process.env.MAPLE_MCP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version':
        message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] || version,
      'Mcp-Method': message.method,
    };
    if (message.params?.name) headers['Mcp-Name'] = message.params.name;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: line,
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
    });
    if (response.status === 202) return;
    const text = await response.text();
    const reply = text ? JSON.parse(text) : null;
    if (!reply || reply.jsonrpc !== '2.0')
      throw new Error(`Maple returned HTTP ${response.status}. Check the URL and access token.`);
    if (message.method === 'initialize' && reply.result?.protocolVersion)
      version = reply.result.protocolVersion;
    process.stdout.write(JSON.stringify(reply) + '\n');
  } catch (error) {
    if (message.id == null) return;
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: `Could not reach Maple. Enable MCP in Maple Settings and keep Maple open. ${error.message}`,
        },
      }) + '\n',
    );
  }
}

// Preserve request order, including initialize and initialized notification.
let pending = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) pending = pending.then(() => forward(line));
});
