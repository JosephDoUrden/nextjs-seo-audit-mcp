import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditFinding, AuditReport } from 'vercel-seo-audit';

// runAudit and the resolver are stubbed here, so these tests control exactly what the
// handler sees. audit.test.ts runs the real audit against a local fixture.
const runAudit = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup, default: { lookup } }));
vi.mock('vercel-seo-audit', async (original) => ({
  ...(await original<typeof import('vercel-seo-audit')>()),
  runAudit,
}));

const { auditSite } = await import('../src/handlers.js');
const { MAX_DETAIL_CHARS, MAX_DETAIL_ITEMS } = await import('../src/sanitise.js');
const { auditSiteInput } = await import('../src/tools.js');
const { z } = await import('zod');

type Text = { type: 'text'; text: string };
const textOf = (r: { content: unknown }) => (r.content as Text[])[0].text;

function finding(code: AuditFinding['code'], url?: string): AuditFinding {
  return {
    code,
    severity: 'warning',
    category: 'metadata',
    message: `${code} found`,
    explanation: '',
    suggestion: 'fix it',
    ...(url !== undefined && { url }),
  };
}

function report(modules: AuditReport['modules']): AuditReport {
  return {
    url: 'https://example.com/',
    timestamp: new Date().toISOString(),
    duration: 1,
    summary: { errors: 0, warnings: modules.flatMap((m) => m.findings).length, info: 0, passed: 0 },
    modules,
    page: { status: 200, finalUrl: 'https://example.com/', nextjs: false },
  };
}

/** A runAudit that never settles until its signal fires, like a site that never answers. */
function hangUntilAborted(_url: string, opts: { signal: AbortSignal }): Promise<never> {
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

/** Makes the wall-clock signal fire after `ms` instead of 120 s. */
function shortWallClock(ms: number) {
  const real = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(ms));
}

describe('audit_site handler', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTJS_SEO_AUDIT_MCP_ALLOW_PRIVATE', '');
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
    runAudit.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('does not report crawl findings as resolved when the current run did not crawl', async () => {
    runAudit.mockResolvedValue(report([{ module: 'metadata', findings: [finding('TITLE_MISSING', 'https://example.com/')] }]));
    const result = await auditSite({
      url: 'https://example.com/',
      previous: {
        tool: 'vercel-seo-audit',
        version: '2.17.0',
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        exitCode: 1,
        summary: { errors: 0, warnings: 2, info: 0 },
        findings: [
          { code: 'TITLE_MISSING', severity: 'warning', category: 'metadata', module: 'metadata', message: 'm', url: 'https://example.com/', fix: null },
          { code: 'CRAWL_PAGE_TITLE_MISSING', severity: 'warning', category: 'crawl', module: 'crawl', message: 'm', url: 'https://example.com/a', fix: null },
        ],
        skipped: [],
        truncated: false,
      },
    });
    expect(result.isError).toBeFalsy();
    const diff = (result.structuredContent as { diff: { new: unknown[]; resolved: { code: string }[]; unchanged: number } }).diff;
    expect(diff.resolved.map((f) => f.code)).toEqual([]);
    expect(diff.new).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it('matches a URL with a format character against its cleaned self in `previous`', async () => {
    const dirty = 'https://example.com/\u200epage\u0085';
    runAudit.mockResolvedValue(report([{ module: 'metadata', findings: [finding('TITLE_MISSING', dirty)] }]));
    const first = await auditSite({ url: 'https://example.com/' });
    const previous = first.structuredContent as Parameters<typeof auditSite>[0]['previous'];
    expect(previous?.findings[0].url).toBe('https://example.com/page');

    const second = await auditSite({ url: 'https://example.com/', previous });
    const diff = (second.structuredContent as { diff: { new: unknown[]; resolved: unknown[]; unchanged: number } }).diff;
    expect(diff).toMatchObject({ new: [], resolved: [], unchanged: 1 });
  });

  it('caps url and finalUrl at 2048 characters', async () => {
    const long = `https://example.com/${'a'.repeat(5000)}`;
    runAudit.mockResolvedValue({
      ...report([{ module: 'metadata', findings: [finding('TITLE_MISSING', long)] }]),
      page: { status: 200, finalUrl: long, nextjs: false },
    });
    const result = await auditSite({ url: 'https://example.com/' });
    const out = result.structuredContent as { finalUrl: string; findings: { url: string }[] };
    expect(out.finalUrl).toHaveLength(2048);
    expect(out.findings[0].url).toHaveLength(2048);
  });

  it('caps `details` in `previous` the same way as the output', async () => {
    runAudit.mockResolvedValue(report([{ module: 'metadata', findings: [] }]));
    const result = await auditSite({
      url: 'https://example.com/',
      previous: {
        tool: 'vercel-seo-audit',
        version: '2.17.0',
        url: 'https://example.com/',
        finalUrl: null,
        exitCode: 1,
        summary: { errors: 0, warnings: 1, info: 0 },
        findings: [
          {
            code: 'TITLE_MISSING',
            severity: 'warning',
            category: 'metadata',
            module: 'metadata',
            message: 'm',
            url: null,
            fix: null,
            details: { list: Array.from({ length: 500 }, (_, i) => i), text: 'x'.repeat(10_000), deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } },
          },
        ],
        skipped: [],
        truncated: false,
      },
    });
    const resolved = (result.structuredContent as { diff: { resolved: { details: Record<string, unknown> }[] } }).diff.resolved;
    expect(resolved).toHaveLength(1);
    const details = resolved[0].details;
    expect(details.list).toHaveLength(MAX_DETAIL_ITEMS);
    expect((details.text as string).length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
    expect(JSON.stringify(details.deep)).not.toContain('"f"');
  });

  it('ignores `diff` in `previous` and bounds `skipped`', () => {
    const schema = z.object(auditSiteInput);
    const base = {
      tool: 'vercel-seo-audit',
      version: '2.17.0',
      url: 'https://example.com/',
      finalUrl: null,
      exitCode: 0,
      summary: { errors: 0, warnings: 0, info: 0 },
      findings: [],
      skipped: [],
      truncated: false,
    };
    const parsed = schema.parse({ url: 'https://example.com/', previous: { ...base, diff: { new: 'x'.repeat(100) } } });
    expect(parsed.previous).not.toHaveProperty('diff');
    const tooMany = { ...base, skipped: Array.from({ length: 33 }, () => 'crawl') };
    expect(schema.safeParse({ url: 'https://example.com/', previous: tooMany }).success).toBe(false);
  });

  it('times out on the wall-clock cap with a message saying so', async () => {
    shortWallClock(100);
    runAudit.mockImplementation(hangUntilAborted);
    const result = await auditSite({ url: 'https://example.com/' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('audit timed out after 120 s');
    // The slot is free again.
    runAudit.mockResolvedValue(report([]));
    expect((await auditSite({ url: 'https://example.com/' })).isError).toBeFalsy();
  });

  it('covers a DNS pre-check that hangs with the same cap', async () => {
    shortWallClock(100);
    lookup.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const result = await auditSite({ url: 'https://slow-dns.example/' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(textOf(result)).toBe('audit timed out after 120 s');
    expect(runAudit).not.toHaveBeenCalled();
  });

  it('can be cancelled during the DNS pre-check', async () => {
    lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await auditSite({ url: 'https://slow-dns.example/' }, { signal: controller.signal });
    expect(textOf(result)).toBe('audit cancelled');
  });

  it('cleans and caps an error message before echoing it', async () => {
    runAudit.mockRejectedValue(new Error(`boom \u202eevil\u0007 \u{E0041}${'y'.repeat(2000)}`));
    const result = await auditSite({ url: 'https://example.com/' });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.startsWith('audit failed: boom evil ')).toBe(true);
    expect(text).not.toMatch(/[\u202e\u0007]|\u{E0041}/u);
    expect(text.length).toBeLessThanOrEqual('audit failed: '.length + 500);
  });

  it('passes a 2 MiB HTML cap to runAudit', async () => {
    runAudit.mockResolvedValue(report([]));
    await auditSite({ url: 'https://example.com/' });
    expect(runAudit.mock.calls[0][1]).toMatchObject({ maxHtmlBytes: 2 * 1024 * 1024 });
  });
});
