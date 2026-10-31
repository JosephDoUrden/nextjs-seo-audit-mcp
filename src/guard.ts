import { lookup } from 'node:dns/promises';
import { cleanString } from './sanitise.js';

/** The one switch that lets audit_site reach a private address, for auditing a local dev server. */
export const ALLOW_PRIVATE_ENV = 'NEXTJS_SEO_AUDIT_MCP_ALLOW_PRIVATE';

export function allowPrivate(): boolean {
  return process.env[ALLOW_PRIVATE_ENV] === '1';
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || // "this network", 0.0.0.0/8
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, where cloud metadata lives
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking, 198.18.0.0/15
    a >= 240 // reserved, 240.0.0.0/4, and broadcast
  );
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
  let host = address.replace(/%.*$/, ''); // zone id, as in fe80::1%en0 from DNS
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    host = `${host.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function isPrivateIpv6(host: string): boolean {
  const g = ipv6Groups(host);
  if (!g) return true; // not an address anything should connect to
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  // The forms that carry an IPv4 address in the last 32 bits are as private as that address.
  if (zero(0, 5) && g[5] === 0xffff) return isPrivateIpv4(ipv4Of(g[6], g[7])); // mapped, ::ffff:0:0/96
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isPrivateIpv4(ipv4Of(g[6], g[7])); // translated, ::ffff:0:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateIpv4(ipv4Of(g[6], g[7])); // NAT64, 64:ff9b::/96
  if (g[0] === 0x2002) return isPrivateIpv4(ipv4Of(g[1], g[2])); // 6to4, 2002::/16
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local, fc00::/7
    (g[0] & 0xffc0) === 0xfe80 || // link-local, fe80::/10
    (g[0] & 0xffc0) === 0xfec0 // site-local, fec0::/10 (deprecated, still routed by some stacks)
  );
}

/**
 * True for `localhost`, or a literal loopback, private, carrier-grade NAT, link-local,
 * benchmarking, reserved or unspecified IPv4 address, or an IPv6 address that is loopback,
 * unspecified, unique-local, link-local, site-local, or carries a private IPv4 address
 * (mapped, translated, NAT64 64:ff9b::/96, 6to4 2002::/16). Based on `isPrivateAddress` in
 * vercel-seo-audit's src/utils/url.ts, copied because the package does not export it, with the
 * extra ranges the CLI is adding too; a test pins the two together once it has them. Pass
 * `new URL(...).hostname` (which has already turned `2130706433` or `0x7f.1` into dotted IPv4)
 * or an address from DNS.
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!host.includes(':')) return isPrivateIpv4(host);
  return isPrivateIpv6(host);
}

export type GuardResult = { ok: true; url: URL } | { ok: false; reason: string };

const IP_LITERAL = /^(\d+\.\d+\.\d+\.\d+|\[.*\])$/;

/**
 * Decides whether audit_site may fetch `input`. Refuses a non-http(s) URL, a literal private
 * address, a name whose DNS answers include any private address, and a name that does not
 * resolve at all, unless NEXTJS_SEO_AUDIT_MCP_ALLOW_PRIVATE=1.
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
    return { ok: false, reason: `not a valid URL: ${JSON.stringify(cleanString(input, 200))}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `only http and https URLs are audited, not ${cleanString(url.protocol, 32)}` };
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
    // Closed, not open: a name that fails here could still resolve when the audit connects.
    return { ok: false, reason: `could not resolve ${url.hostname}` };
  }
  if (answers.length === 0) return { ok: false, reason: `could not resolve ${url.hostname}` };
  const bad = answers.find((a) => isPrivateAddress(a.address));
  if (bad) return refusal(`${url.hostname} resolves to ${bad.address}, which`);
  return { ok: true, url };
}
