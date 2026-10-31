import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture, type Fixture } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** Copies every byte the server writes to stdout, next to the SDK's own reader. */
class SpiedTransport extends StdioClientTransport {
  readonly stdout: Buffer[] = [];
  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as { _process: ChildProcess })._process;
    child.stdout?.on('data', (chunk: Buffer) => this.stdout.push(chunk));
  }
}

describe('stdio', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    if (!existsSync(entry)) execFileSync('npx', ['tsc'], { cwd: root, stdio: 'ignore' });
    fixture = await startFixture();
  });
  afterAll(() => fixture.close());

  it('writes only JSON-RPC frames to stdout, even when something calls console.log', async () => {
    // Preloaded before the server: logs to stdout once the server is up, which the
    // console.log pin in index.ts has to send to stderr instead.
    const stray = 'data:text/javascript,setTimeout(()=>{console.log("stray");console.info("stray")},200)';
    const transport = new SpiedTransport({
      command: process.execPath,
      args: ['--import', stray, entry],
      env: { ...getDefaultEnvironment(), VERCEL_SEO_AUDIT_MCP_ALLOW_PRIVATE: '1' },
      stderr: 'pipe',
    });
    const stderr: Buffer[] = [];
    transport.stderr?.on('data', (c: Buffer) => stderr.push(c));
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(3);
    await client.callTool({ name: 'explain_finding', arguments: { code: 'TITLE_MISSING' } });
    await client.callTool({ name: 'explain_finding', arguments: { code: 'NOPE' } });
    await client.callTool({ name: 'list_checks', arguments: {} });
    const audit = await client.callTool({ name: 'audit_site', arguments: { url: fixture.url, timeout: 5000 } });
    expect(audit.isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 300));
    await client.close();

    const lines = Buffer.concat(transport.stdout).toString('utf8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      const frame = JSON.parse(line) as { jsonrpc?: string };
      expect(frame.jsonrpc).toBe('2.0');
    }
    expect(Buffer.concat(stderr).toString('utf8')).toContain('stray');
  }, 60_000);
});
