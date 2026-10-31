import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { VERSION } from 'vercel-seo-audit';
import { UNTRUSTED_NOTICE } from '../src/sanitise.js';
import { auditSite } from '../src/handlers.js';
import { UNSAFE, allStrings, connectClient, page, startFixture, type Fixture } from './helpers.js';

type Text = { type: 'text'; text: string };
interface Finding {
  code: string;
  severity: string;
  module: string;
  message: string;
  url: string | null;
  fix: string | null;
  details?: Record<string, unknown>;
}
interface Report {
  tool: string;
  version: string;
  url: string;
  exitCode: number;
  summary: { errors: number; warnings: number; info: number };
  findings: Finding[];
  skipped: string[];
  truncated: boolean;
  diff?: { new: Finding[]; resolved: Finding[]; unchanged: number };
}

describe('audit_site against a local fixture', () => {
  let fixture: Fixture;
  let client: Client;
  let close: () => Promise<void>;
  let first: Report;

  beforeAll(async () => {
    // The fixture is on 127.0.0.1, so the private-address guard is switched off for this file only.
    vi.stubEnv('NEXTJS_SEO_AUDIT_MCP_ALLOW_PRIVATE', '1');
    fixture = await startFixture();
    ({ client, close } = await connectClient());
  });
  afterAll(async () => {
    await close();
    await fixture.close();
    vi.unstubAllEnvs();
  });

  it('returns an AgentReport as structuredContent, with the untrusted notice first in the text', async () => {
    const result = await client.callTool({ name: 'audit_site', arguments: { url: fixture.url, timeout: 5000 } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Text[];
    expect(content).toHaveLength(1);
    const [notice, json] = content[0].text.split('\n');
    expect(notice).toBe(UNTRUSTED_NOTICE);
    expect(JSON.parse(json)).toEqual(result.structuredContent);

    first = result.structuredContent as unknown as Report;
    expect(first).toMatchObject({ tool: 'vercel-seo-audit', version: VERSION, url: fixture.url, truncated: false });
    expect(first.skipped).toContain('crawl');
    expect(first.diff).toBeUndefined();
    expect(first.findings.length).toBeGreaterThan(0);
    expect(first.findings.every((f) => f.severity !== 'pass')).toBe(true);
  });

  it('strips bidi and control characters from page-sourced values', () => {
    const soft404 = first.findings.find((f) => f.code === 'SOFT_404');
    expect(soft404?.details?.title).toBe('Shop exe.txt home');
    for (const s of allStrings(first)) expect(s).not.toMatch(UNSAFE);
    for (const f of first.findings) {
      expect(f.message.length).toBeLessThanOrEqual(500);
      if (f.fix) expect(f.fix.length).toBeLessThanOrEqual(500);
    }
  });

  it('diffs against `previous`', async () => {
    fixture.html = page({ title: null });
    try {
      const result = await client.callTool({
        name: 'audit_site',
        arguments: { url: fixture.url, timeout: 5000, previous: first as unknown as Record<string, unknown> },
      });
      expect(result.isError).toBeFalsy();
      const report = result.structuredContent as unknown as Report;
      expect(report.diff).toBeDefined();
      expect(report.diff?.new.map((f) => f.code)).toContain('TITLE_MISSING');
      expect(report.diff?.resolved.map((f) => f.code)).not.toContain('TITLE_MISSING');
      expect(report.diff?.unchanged).toBeGreaterThan(0);
    } finally {
      fixture.html = page();
    }
  });

  it('runs one audit at a time', async () => {
    fixture.delayMs = 300;
    try {
      const running = auditSite({ url: fixture.url, only: ['metadata'], timeout: 5000 });
      const second = await auditSite({ url: fixture.url, only: ['metadata'] });
      expect(second.isError).toBe(true);
      expect((second.content[0] as Text).text).toMatch(/^audit already running/);
      const done = await running;
      expect(done.isError).toBeFalsy();
    } finally {
      fixture.delayMs = 0;
    }
    const after = await auditSite({ url: fixture.url, only: ['metadata'] });
    expect(after.isError).toBeFalsy();
  });

  it('stops on cancellation and frees the slot', async () => {
    fixture.delayMs = 3000;
    const controller = new AbortController();
    try {
      const running = auditSite({ url: fixture.url, only: ['metadata'], timeout: 10_000 }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      const started = Date.now();
      const result = await running;
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.isError).toBe(true);
      expect((result.content[0] as Text).text).toBe('audit cancelled');
    } finally {
      fixture.delayMs = 0;
    }
    const after = await auditSite({ url: fixture.url, only: ['metadata'] });
    expect(after.isError).toBeFalsy();
  });

  it('reads no .seoauditrc.json or .seoauditignore from the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-mcp-'));
    writeFileSync(join(dir, '.seoauditignore'), 'SOFT_404\n');
    writeFileSync(join(dir, '.seoauditrc.json'), JSON.stringify({ ignore: ['SOFT_404'], only: ['robots'] }));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await auditSite({ url: fixture.url, timeout: 5000 });
      const report = result.structuredContent as unknown as Report;
      expect(report.findings.map((f) => f.code)).toContain('SOFT_404');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads only NEXTJS_SEO_AUDIT_MCP_ALLOW_PRIVATE and NO_COLOR from the environment', async () => {
    const read = new Set<string>();
    const real = process.env;
    process.env = new Proxy(real, {
      get(target, key, receiver) {
        if (typeof key === 'string') read.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const { client: c, close: closeClient } = await connectClient();
      await c.callTool({ name: 'list_checks', arguments: {} });
      await c.callTool({ name: 'explain_finding', arguments: { code: 'SOFT_404' } });
      await c.callTool({ name: 'audit_site', arguments: { url: fixture.url, timeout: 5000 } });
      await closeClient();
    } finally {
      process.env = real;
    }
    expect([...read].filter((k) => !['NEXTJS_SEO_AUDIT_MCP_ALLOW_PRIVATE', 'NO_COLOR'].includes(k))).toEqual([]);
  });

  it('rejects out-of-range input as a tool error', async () => {
    const result = await client.callTool({ name: 'audit_site', arguments: { url: fixture.url, crawl: 51 } });
    expect(result.isError).toBe(true);
    const tooLong = await client.callTool({ name: 'audit_site', arguments: { url: `https://example.com/${'a'.repeat(2048)}` } });
    expect(tooLong.isError).toBe(true);
  });
});
