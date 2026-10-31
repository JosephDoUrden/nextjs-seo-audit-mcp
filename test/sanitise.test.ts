import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS, capFinding, cleanDeep, cleanString } from '../src/sanitise.js';
import { clamp, previousToAuditReport } from '../src/handlers.js';
import { UNSAFE, allStrings } from './helpers.js';

describe('sanitise', () => {
  it('strips C0, DEL, C1 and bidi characters', () => {
    expect(cleanString('a\u0000b\u0007c\u007fd\u0085e‮f⁦g‏h')).toBe('abcdefgh');
  });

  it('turns tab and newlines into spaces', () => {
    expect(cleanString('one\ntwo\tthree\r\nfour')).toBe('one two three  four');
  });

  it('cleans keys and nested values', () => {
    const out = cleanDeep({ 'k‮': ['v\u0001', { deep: 'x⁧y' }], n: 3, b: null });
    expect(out).toEqual({ k: ['v', { deep: 'xy' }], n: 3, b: null });
    expect(allStrings(out).some((s) => UNSAFE.test(s))).toBe(false);
  });

  it('caps message and fix at 500 characters', () => {
    const long = 'x'.repeat(2000);
    const out = capFinding({ message: long, fix: long });
    expect(out.message).toHaveLength(MAX_TEXT_CHARS);
    expect(out.fix).toHaveLength(MAX_TEXT_CHARS);
    expect(capFinding({ message: 'm', fix: null }).fix).toBeNull();
  });
});

describe('handler helpers', () => {
  it('clamps', () => {
    expect(clamp(5, 1000, 30000)).toBe(1000);
    expect(clamp(99999, 1000, 30000)).toBe(30000);
    expect(clamp(1500.7, 1000, 30000)).toBe(1500);
  });

  it('rebuilds an AuditReport from an AgentReport keyed by code and url', () => {
    const report = previousToAuditReport({
      tool: 'vercel-seo-audit',
      version: '2.16.0',
      url: 'https://example.com/',
      finalUrl: 'https://example.com/',
      exitCode: 1,
      summary: { errors: 1, warnings: 0, info: 0 },
      findings: [
        {
          code: 'TITLE_MISSING',
          severity: 'warning',
          category: 'metadata',
          module: 'metadata',
          message: 'No <title> tag found',
          url: 'https://example.com/',
          fix: null,
        },
      ],
      skipped: ['crawl'],
      truncated: false,
    });
    expect(report.modules).toEqual([
      { module: 'metadata', findings: [expect.objectContaining({ code: 'TITLE_MISSING', url: 'https://example.com/' })] },
    ]);
    expect(report.only).not.toContain('crawl');
    expect(report.only).toContain('metadata');
  });
});
