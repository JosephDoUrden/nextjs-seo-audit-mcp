import { lookup } from 'node:dns/promises';

/** The one switch that lets audit_site reach a private address, for auditing a local dev server. */
export const ALLOW_PRIVATE_ENV = 'VERCEL_SEO_AUDIT_MCP_ALLOW_PRIVATE';

export function allowPrivate(): boolean {
  return process.env[ALLOW_PRIVATE_ENV] === '1';
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, where cloud metadata lives
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * True for `localhost`, or a literal loopback, private, carrier-grade NAT, link-local or
 * unspecified address, IPv4 or IPv6. Same rules as `isPrivateAddress` in vercel-seo-audit's
 * src/utils/url.ts, copied because the package does not export it. Pass `new URL(...).hostname`
 * (which has already turned `2130706433` or `0x7f.1` into dotted IPv4) or an address from DNS.
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!host.includes(':')) return isPrivateIpv4(host);
  if (host === '::' || host === '::1') return true;
  // IPv4-mapped, as written (::ffff:127.0.0.1) or as new URL() prints it (::ffff:7f00:1)
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
  if (mapped) {
    if (mapped[1]) return isPrivateIpv4(mapped[1]);
    const hi = parseInt(mapped[2], 16);
    const lo = parseInt(mapped[3], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = parseInt(host.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local, fc00::/7
    (first & 0xffc0) === 0xfe80 // link-local, fe80::/10
  );
}

export type GuardResult = { ok: true; url: URL } | { ok: false; reason: string };

const IP_LITERAL = /^(\d+\.\d+\.\d+\.\d+|\[.*\])$/;

/**
 * Decides whether audit_site may fetch `input`. Refuses a non-http(s) URL, a literal private
 * address, and a name whose DNS answers include any private address, unless
 * VERCEL_SEO_AUDIT_MCP_ALLOW_PRIVATE=1.
 *
 * Not covered: DNS rebinding. The name is looked up again when the request is made and can
 * answer differently then. vercel-seo-audit itself refuses redirects, sitemap URLs and links
 * from a public site to a literal private address.
 */
export async function checkTarget(input: string): Promise<GuardResult> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: `not a valid URL: ${JSON.stringify(input.slice(0, 200))}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `only http and https URLs are audited, not ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with credentials are refused' };
  }
  if (allowPrivate()) return { ok: true, url };

  const refusal = (what: string) => ({
    ok: false as const,
    reason: `${what} is a private address; set ${ALLOW_PRIVATE_ENV}=1 to audit a local server`,
  });
  if (isPrivateAddress(url.hostname)) return refusal(url.hostname);
  if (IP_LITERAL.test(url.hostname)) return { ok: true, url };

  let answers: { address: string }[];
  try {
    answers = await lookup(url.hostname, { all: true });
  } catch {
    // Left to the audit, which reports TARGET_UNREACHABLE with the resolver's error.
    return { ok: true, url };
  }
  const bad = answers.find((a) => isPrivateAddress(a.address));
  if (bad) return refusal(`${url.hostname} resolves to ${bad.address}, which`);
  return { ok: true, url };
}
