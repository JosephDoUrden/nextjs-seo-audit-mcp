/**
 * Puts the same McpServer on Streamable HTTP at 127.0.0.1 on a random port, so the official
 * conformance suite (@modelcontextprotocol/conformance, which only speaks HTTP) can run
 * against it in CI. Test-only: it is not in `files` and the published server is stdio only.
 *
 *   npm run build && node --experimental-strip-types test/conformance-shim.ts
 *
 * Prints `MCP_URL=<url>` on stdout once listening. Stateless: a fresh server per request.
 * Requests whose Host is not a loopback name are refused with 403 (dns-rebinding scenario).
 */
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Loaded from the build at runtime; typed from the source.
const distServer = new URL('../dist/server.js', import.meta.url).href;
const { createServer } = (await import(distServer)) as typeof import('../src/server.js');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const http = createHttpServer(async (req, res) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOOPBACK.has(host)) {
    res.writeHead(403, { 'content-type': 'application/json' }).end(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden host' }, id: null }),
    );
    return;
  }
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

http.listen(0, '127.0.0.1', () => {
  const { port } = http.address() as AddressInfo;
  process.stdout.write(`MCP_URL=http://127.0.0.1:${port}/mcp\n`);
});
