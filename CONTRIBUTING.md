# Contributing

```bash
git clone https://github.com/<your-username>/nextjs-seo-audit-mcp.git
cd nextjs-seo-audit-mcp
npm ci
npm run build
npm test
npm run typecheck
```

- The audit checks live in [vercel-seo-audit](https://github.com/JosephDoUrden/vercel-seo-audit).
  A new check or a false positive belongs there; this repo only wraps it.
- Match the code that is there. `.js` extensions in imports, `import type` for types.
- Nothing may write to stdout except the transport. Use `console.error` if you must log.
- A change to a tool's schema or description changes the `tools/list` snapshot. Update it with
  `npx vitest run -u` and say why in the PR.
- Adding a tool, an input or an environment variable is a design change; open an issue first. See
  [docs/DESIGN.md](docs/DESIGN.md).

Commits follow `type: description`, with `feat`, `fix`, `docs`, `test`, `chore` or `refactor`.
Release notes are generated from them.
