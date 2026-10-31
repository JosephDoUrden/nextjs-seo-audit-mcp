# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

Fixes ship in the next patch release on npm.

## Reporting a vulnerability

Do not open a public issue. Use
[GitHub's private vulnerability reporting](https://github.com/JosephDoUrden/nextjs-seo-audit-mcp/security/advisories/new)
on this repository (Security tab, "Report a vulnerability"). If that is not an option, email the
maintainer (see the `author` field in `package.json`).

Please include what you found, steps to reproduce and the impact you expect. You should get an
acknowledgement within 48 hours and a first assessment within 7 days. Fixes are credited in the
release notes unless you would rather not be. Please give us the chance to ship a fix before any
public disclosure.

## Scope notes

- The server is stdio only. There is no HTTP listener, so there is no auth: whoever can start the
  process already has the machine. `test/conformance-shim.ts` mounts it on HTTP for CI only and is
  not published.
- `audit_site` makes outbound requests to the URL it is given. Private and local addresses are
  refused unless `NEXTJS_SEO_AUDIT_MCP_ALLOW_PRIVATE=1`; DNS rebinding is a known gap, described in
  the README.
- Results are content from a third-party site. They are cleaned of control and format characters
  (bidi, zero-width, tags) and capped, but a client must still treat them as data.
- `@modelcontextprotocol/sdk` is held at `^1.32.0` or newer. 1.32.0 fixes five advisories
  published on 20 Oct 2026, and 1.31.0 fixed CVE-2026-104850. A lower floor would let `npm install`
  resolve a vulnerable SDK.
- CI fails on any high or critical advisory in the runtime dependency tree
  (`npm audit --omit=dev --audit-level=high`). Releases are published from GitHub Actions with npm
  provenance.
