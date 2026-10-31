import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { auditSite, explainFinding, listChecks } from './handlers.js';
import {
  TOOL_DEFS,
  auditSiteInput,
  auditSiteOutput,
  explainFindingInput,
  explainFindingOutput,
  listChecksInput,
  listChecksOutput,
} from './tools.js';
import { SERVER_VERSION } from './version.js';

/** The server with its three tools. index.ts puts it on stdio; the conformance shim on HTTP. */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'nextjs-seo-audit-mcp', title: 'Next.js SEO Audit', version: SERVER_VERSION });

  server.registerTool(
    'audit_site',
    { ...TOOL_DEFS.audit_site, inputSchema: auditSiteInput, outputSchema: auditSiteOutput },
    (args, extra) => auditSite(args, { signal: extra.signal }),
  );
  server.registerTool(
    'explain_finding',
    { ...TOOL_DEFS.explain_finding, inputSchema: explainFindingInput, outputSchema: explainFindingOutput },
    (args) => explainFinding(args),
  );
  server.registerTool(
    'list_checks',
    { ...TOOL_DEFS.list_checks, inputSchema: listChecksInput, outputSchema: listChecksOutput },
    () => listChecks(),
  );

  // McpServer declares `tools.listChanged: true` when the first tool is registered. The tool
  // set here never changes, so the capability is set back before connect().
  server.server.registerCapabilities({ tools: { listChanged: false } });
  return server;
}
