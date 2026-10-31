/**
 * Entry point: the MCP server on stdio. Stdout carries JSON-RPC frames and nothing else, so
 * console.log and friends are pointed at stderr before any other module loads. The imports
 * below are dynamic for that reason: a static import would run its module first.
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { createServer } = await import('./server.js');

const server = createServer();
await server.connect(new StdioServerTransport());

const shutdown = () => {
  void server.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
