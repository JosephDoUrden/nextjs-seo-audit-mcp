import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ISSUE_CODES, MODULE_IDS, VERSION } from 'vercel-seo-audit';
import { connectClient } from './helpers.js';

type Text = { type: 'text'; text: string };

describe('explain_finding and list_checks', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ client, close } = await connectClient());
  });
  afterAll(() => close());

  it('explains a known code', async () => {
    const result = await client.callTool({ name: 'explain_finding', arguments: { code: 'NOINDEX_DETECTED' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      code: 'NOINDEX_DETECTED',
      modules: ['metadata'],
      categories: ['indexing'],
    });
    const text = (result.content as Text[])[0].text;
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it('forgives case and dashes', async () => {
    const result = await client.callTool({ name: 'explain_finding', arguments: { code: 'title-missing' } });
    expect(result.structuredContent).toMatchObject({ code: 'TITLE_MISSING' });
  });

  it('answers an unknown code with isError and the three closest codes', async () => {
    const result = await client.callTool({ name: 'explain_finding', arguments: { code: 'TITLE_MISING' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as Text[])[0].text;
    const closest = /closest: (.*)$/.exec(text)?.[1].split(', ');
    expect(closest).toHaveLength(3);
    expect(closest?.[0]).toBe('TITLE_MISSING');
    for (const code of closest ?? []) expect(ISSUE_CODES).toContain(code);
  });

  it('cleans an unknown code before echoing it', async () => {
    const result = await client.callTool({ name: 'explain_finding', arguments: { code: 'X‮\u0007Y' } });
    const text = (result.content as Text[])[0].text;
    expect(text).not.toMatch(/[‮\u0007]/);
  });

  it('lists every module with its codes', async () => {
    const result = await client.callTool({ name: 'list_checks', arguments: {} });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      version: string;
      modules: { id: string; codes: { code: string; description: string }[] }[];
    };
    expect(out.version).toBe(VERSION);
    expect(out.modules.map((m) => m.id)).toEqual(['target', ...MODULE_IDS]);
    for (const m of out.modules) {
      expect(m.codes.length).toBeGreaterThan(0);
      for (const c of m.codes) expect(c.description.length).toBeGreaterThan(0);
    }
    const listed = new Set(out.modules.flatMap((m) => m.codes.map((c) => c.code)));
    expect([...listed].sort()).toEqual([...ISSUE_CODES].sort());
  });
});
