import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS, capFinding, cleanDeep, cleanString } from '../src/sanitise.js';
import { clamp, previousToAuditReport } from '../src/handlers.js';
import { UNSAFE, allStrings } from './helpers.js';

describe('sanitise', () => {
  it('strips C0, DEL, C1 and bidi characters', () => {
    expect(cleanString('a\u0000b\u0007c\u007fd\u0085e\u202ef\u2066g\u200fh')).toBe('abcdefgh');
  });

  it('turns tab and newlines into spaces', () => {
    expect(cleanString('one\ntwo\tthree\r\nfour')).toBe('one two three  four');
  });

  it('turns the Unicode line and paragraph separators into spaces', () => {
    expect(cleanString('one\u2028two\u2029three')).toBe('one two three');
  });

  it('strips format characters: zero-width, BOM, soft hyphen, ALM and the tag block', () => {
    const tags = [...'ignore'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    const input = `a\u200bb\u200cc\u200dd\ufeffe\u00adf\u061cg\u{E0001}${tags}\u{E007F}h\u{E0000}i`;
    expect(cleanString(input)).toBe('abcdefghi');
    expect(UNSAFE.test(cleanString(input))).toBe(false);
  });

  it('keeps ordinary text, accents and emoji', () => {
    expect(cleanString('Café — naïve 日本語 🙂')).toBe('Café — naïve 日本語 🙂');
  });

  it('cleans keys and nested values', () => {
    const out = cleanDeep({ 'k\u202e': ['v\u0001', { deep: 'x\u2067y' }], n: 3, b: null });
    expect(out).toEqual({ k: ['v', { deep: 'xy' }], n: 3, b: null });
    expect(allStrings(out).some((s) => UNSAFE.test(s))).toBe(false);
  });

  it('caps message and fix at 500 characters', () => {
    const long = 'x'.repeat(2000);
    const out = capFinding({ message: long, fix: long, url: null });
    expect(out.message).toHaveLength(MAX_TEXT_CHARS);
    expect(out.fix).toHaveLength(MAX_TEXT_CHARS);
    expect(capFinding({ message: 'm', fix: null, url: null }).fix).toBeNull();
  });

  it('caps url at 2048 characters', () => {
    const out = capFinding({ message: 'm', fix: null, url: `https://example.com/${'a'.repeat(3000)}` });
    expect(out.url).toHaveLength(2048);
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
