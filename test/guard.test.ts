import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup, default: { lookup } }));

const { checkTarget, isPrivateAddress } = await import('../src/guard.js');
const { auditSite } = await import('../src/handlers.js');

describe('guard', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL_SEO_AUDIT_MCP_ALLOW_PRIVATE', '');
    lookup.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    'http://127.0.0.1/',
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
  ])('refuses the literal private address %s without a lookup', async (url) => {
    const result = await checkTarget(url);
    expect(result.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url'])(
    'refuses %s',
    async (url) => {
      expect((await checkTarget(url)).ok).toBe(false);
    },
  );

  it('refuses a URL with credentials', async () => {
    expect((await checkTarget('https://user:pass@example.com/')).ok).toBe(false);
  });

  it('refuses a name that resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const result = await checkTarget('https://evil.example/');
    expect(lookup).toHaveBeenCalledWith('evil.example', { all: true });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('resolves to 10.0.0.5'),
    });
  });

  it('refuses a name when any one answer is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.215.14', family: 4 },
      { address: '::1', family: 6 },
    ]);
    expect((await checkTarget('https://mixed.example/')).ok).toBe(false);
  });

  it('allows a name with only public answers', async () => {
    lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
    expect((await checkTarget('https://example.com/')).ok).toBe(true);
  });

  it('leaves a failed lookup to the audit', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    expect((await checkTarget('https://nope.example/')).ok).toBe(true);
  });

  it('allows private addresses with VERCEL_SEO_AUDIT_MCP_ALLOW_PRIVATE=1', async () => {
    vi.stubEnv('VERCEL_SEO_AUDIT_MCP_ALLOW_PRIVATE', '1');
    expect((await checkTarget('http://127.0.0.1:3000/')).ok).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not treat other values of the flag as on', async () => {
    vi.stubEnv('VERCEL_SEO_AUDIT_MCP_ALLOW_PRIVATE', 'true');
    expect((await checkTarget('http://127.0.0.1/')).ok).toBe(false);
  });

  it('audit_site returns isError for a refused target and frees the slot', async () => {
    lookup.mockResolvedValue([{ address: '192.168.0.10', family: 4 }]);
    const result = await auditSite({ url: 'https://rebind.example/' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^refused: /) });
    const again = await auditSite({ url: 'http://127.0.0.1/' });
    expect(again.content[0]).toMatchObject({ text: expect.stringMatching(/^refused: /) });
  });

  it('isPrivateAddress reads DNS answers too', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
});
