import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectClient } from './helpers.js';

describe('tools/list', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ client, close } = await connectClient());
  });
  afterAll(() => close());

  it('matches the snapshot', async () => {
    const { tools } = await client.listTools();
    expect(tools).toMatchSnapshot();
  });

  it('has exactly the three tools, with explicit annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['audit_site', 'explain_finding', 'list_checks']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    expect(byName.audit_site.annotations).toMatchObject({ openWorldHint: true, idempotentHint: false });
    expect(byName.explain_finding.annotations).toMatchObject({ openWorldHint: false, idempotentHint: true });
    expect(byName.list_checks.annotations).toMatchObject({ openWorldHint: false, idempotentHint: true });
  });

  it('declares tools without listChanged, and no resources or prompts', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toEqual({ listChanged: false });
    expect(caps?.resources).toBeUndefined();
    expect(caps?.prompts).toBeUndefined();
  });

  it('answers an unknown tool with an error', async () => {
    const result = await client.callTool({ name: 'audit_page', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
